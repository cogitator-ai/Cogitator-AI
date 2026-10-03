import { ws } from '@tetsujs/core';
import type { ValidationIssue } from '@tetsujs/core';
import type { z } from 'zod';
import type { callerHook } from './auth.js';
import { describeError } from './errors.js';
import {
  checkThreadAccess,
  executeSwarm,
  executeWorkflow,
  findAgent,
  findSwarm,
  findWorkflow,
  resumeAgent,
  runAgent,
  toAgentRunResponse,
  toResumeDecisions,
  toSwarmRunResponse,
  toWorkflowRunResponse,
} from './operations.js';
import { SocketMessage } from './schemas.js';
import { resolveSignal } from './streaming.js';
import type { AgentStreamCallbacks } from './streaming.js';
import type { AuthContext, CogitatorDeps, WebSocketServerMessage } from './types.js';

type ClientMessage = z.output<typeof SocketMessage>;
type RunMessage = Extract<ClientMessage, { type: 'run' | 'resume' }>;
type RunPayload = Extract<ClientMessage, { type: 'run' }>['payload'];
type ResumePayload = Extract<ClientMessage, { type: 'resume' }>['payload'];
type Emit = (event: Record<string, unknown>) => void;

interface SocketLike {
  readonly readyState: number;
  send(data: string): unknown;
}

const OPEN = 1;
const DEFAULT_PATH = '/ws' as const;

/**
 * The WebSocket endpoint of `cogitatorController()`.
 *
 * The handshake runs the same `auth` as the HTTP routes. Each socket runs one
 * agent, workflow or swarm at a time; `stop` cancels it, and so does closing the
 * socket.
 */
export function cogitatorSocket(
  deps: CogitatorDeps,
  caller: ReturnType<typeof callerHook>,
  path: `/${string}` = DEFAULT_PATH
) {
  const running = new WeakMap<object, AbortController>();

  return ws({
    path,
    hooks: { beforeParse: [caller] },
    schema: { message: SocketMessage },
    docs: {
      summary: 'Run agents, workflows and swarms over a WebSocket',
      description:
        'Send `{ type: "run", id, payload: { type, name, input } }`, `{ type: "resume", id, payload: { name, threadId, decisions } }` to continue an agent run paused for approvals, `{ type: "stop" }` or `{ type: "ping" }`.',
    },
    until: () => resolveSignal(deps.until),
    message: (socket, message) => {
      switch (message.type) {
        case 'ping':
          send(socket, { type: 'pong', id: message.id });
          return;
        case 'stop':
          running.get(socket)?.abort();
          return;
        case 'run':
        case 'resume': {
          if (running.has(socket)) {
            send(socket, {
              type: 'error',
              id: message.id,
              error: 'A run is already in progress',
              code: 'RUN_IN_PROGRESS',
            });
            return;
          }
          const controller = new AbortController();
          running.set(socket, controller);
          return handleRun(deps, socket, message, socket.data.cogitatorAuth, {
            signal: controller.signal,
          }).finally(() => {
            if (running.get(socket) === controller) running.delete(socket);
          });
        }
      }
    },
    invalid: (socket, issues: readonly ValidationIssue[]) => {
      send(socket, {
        type: 'error',
        error: issues[0]?.message ?? 'Invalid message',
        code: 'INVALID_MESSAGE',
      });
    },
    close: (socket) => {
      running.get(socket)?.abort();
      running.delete(socket);
    },
  });
}

async function handleRun(
  deps: CogitatorDeps,
  socket: SocketLike,
  message: RunMessage,
  auth: AuthContext | undefined,
  { signal }: { signal: AbortSignal }
): Promise<void> {
  const id = message.id;
  const emit: Emit = (event) => send(socket, { type: 'event', id, payload: event });

  try {
    const result =
      message.type === 'resume'
        ? await resume(deps, message.payload, auth, signal, emit)
        : await execute(deps, message.payload, auth, signal, emit);
    emit(signal.aborted ? { type: 'cancelled' } : { type: 'complete', result });
  } catch (error) {
    if (signal.aborted) {
      emit({ type: 'cancelled' });
      return;
    }
    const described = describeError(error);
    send(socket, { type: 'error', id, error: described.message, code: described.code });
    if (described.unexpected) throw error;
  }
}

function agentCallbacks(signal: AbortSignal, emit: Emit): AgentStreamCallbacks {
  return {
    stream: true,
    signal,
    onToken: (delta) => emit({ type: 'token', delta }),
    onReasoning: (delta) => emit({ type: 'reasoning', delta }),
    onToolCall: (call) =>
      emit({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }),
    onToolResult: (toolResult) => emit({ type: 'tool-result', ...toolResult }),
  };
}

async function resume(
  deps: CogitatorDeps,
  payload: ResumePayload,
  auth: AuthContext | undefined,
  signal: AbortSignal,
  emit: Emit
): Promise<unknown> {
  const agent = findAgent(deps, payload.name);
  await checkThreadAccess(deps, auth, payload.threadId);
  const result = await resumeAgent(
    deps,
    agent,
    payload.threadId,
    { ...toResumeDecisions(payload), ...agentCallbacks(signal, emit) },
    auth
  );
  return toAgentRunResponse(result);
}

async function execute(
  deps: CogitatorDeps,
  payload: RunPayload,
  auth: AuthContext | undefined,
  signal: AbortSignal,
  emit: Emit
): Promise<unknown> {
  switch (payload.type) {
    case 'agent': {
      const agent = findAgent(deps, payload.name);
      await checkThreadAccess(deps, auth, payload.threadId);
      const result = await runAgent(
        deps,
        agent,
        {
          input: payload.input,
          context: payload.context,
          threadId: payload.threadId,
          ...agentCallbacks(signal, emit),
        },
        auth
      );
      return toAgentRunResponse(result);
    }

    case 'workflow': {
      const workflow = findWorkflow(deps, payload.name);
      const result = await executeWorkflow(deps, workflow, { input: payload.input }, {}, signal);
      return toWorkflowRunResponse(result);
    }

    case 'swarm': {
      const config = findSwarm(deps, payload.name);
      await checkThreadAccess(deps, auth, payload.threadId);
      const { swarm, result } = await executeSwarm(
        deps,
        config,
        { input: payload.input, context: payload.context, threadId: payload.threadId },
        auth,
        signal
      );
      return toSwarmRunResponse(swarm, result);
    }
  }
}

function send(socket: SocketLike, message: WebSocketServerMessage): void {
  if (socket.readyState !== OPEN) return;
  socket.send(JSON.stringify(message));
}
