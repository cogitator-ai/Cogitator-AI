import { hook, ws } from '@tetsujs/core';
import type { ValidationIssue } from '@tetsujs/core';
import type { z } from 'zod';
import type { anonymousHook, CallerHook } from './auth.js';
import { describeError, unwrapWorkflowFailure } from './errors.js';
import { runRequestRunOptions, toAgentRunResponse } from '@cogitator-ai/server-shared';
import {
  checkThreadAccess,
  executeSwarm,
  executeWorkflow,
  findAgent,
  findSwarm,
  findWorkflow,
  resumeAgent,
  runAgent,
  runDepsOf,
  toResumeOptions,
  toSwarmRunResponse,
  toWorkflowRunResponse,
} from './operations.js';
import type { RunDeps } from './operations.js';
import { requestSchemas, type SocketMessage } from './schemas.js';
import { resolveSignal } from './streaming.js';
import type { AgentStreamCallbacks } from './streaming.js';
import { SocketOutbox, type OutboxSocket } from './socket-outbox.js';
import type { AuthContext, CogitatorDeps, WebSocketOptions } from './types.js';

type ClientMessage = z.output<typeof SocketMessage>;
type RunMessage = Extract<ClientMessage, { type: 'run' | 'resume' }>;
type RunPayload = Extract<ClientMessage, { type: 'run' }>['payload'];
type ResumePayload = Extract<ClientMessage, { type: 'resume' }>['payload'];
type Emit = (event: Record<string, unknown>) => void;

const DEFAULT_PATH = '/ws' as const;
/** Default of `websocket.maxRuns`: the runs a socket may have going at once */
export const DEFAULT_MAX_SOCKET_RUNS = 8;
/** Default of `websocket.maxBufferedBytes`: what may wait for a client that reads slowly */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * The runs of one socket by the `id` of the frame that started them, the stopped ones still
 * winding down, which count toward `maxRuns` but no longer hold their `id`, and what it sends
 */
interface SocketState {
  runs: Map<string | undefined, AbortController>;
  stopping: Set<AbortController>;
  outbox: SocketOutbox;
}

/** Cancels a run: its `id` is free at once, and it counts as stopping until it ends */
function stopRun(state: SocketState, id: string | undefined): void {
  const run = state.runs.get(id);
  if (!run) return;
  state.runs.delete(id);
  state.stopping.add(run);
  run.abort();
}

/** What the handshake adds to a socket: the `deps` of every agent run on the connection */
export interface ConnectionDeps {
  cogitatorDeps: RunDeps;
}

/**
 * The `beforeParse` hook of the handshake that builds the connection's `deps` with the `deps`
 * hook. A Tetsu context belongs to its request, not to the connection that outlives it, so
 * they are built once, from the handshake, rather than for each run.
 */
function connectionDeps(deps: CogitatorDeps) {
  return hook.beforeParse(async (ctx): Promise<ConnectionDeps> => ({
    cogitatorDeps: await runDepsOf(deps, ctx),
  }));
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`websocket.${name} must be a positive integer, got ${value}`);
  }
  return value;
}

function alreadyRunning(id: string | undefined): string {
  return id === undefined
    ? 'A run is already in progress: give each run its own id to run several at once'
    : `A run with id '${id}' is already in progress`;
}

/**
 * The WebSocket endpoint of `cogitatorController()`.
 *
 * The handshake runs the same `auth` and `anonymous` policy as the HTTP routes. A socket runs
 * up to `maxRuns` agents, workflows and swarms at once, told apart by the `id` of the frame
 * that started each: `stop` with an `id` cancels that run, and `stop` without one, or closing
 * the socket, cancels them all. What the server sends waits for a client that reads slowly,
 * up to `maxBufferedBytes`, past which the socket is closed. Workflow and swarm runs are held
 * to the server's `limits`.
 */
export function cogitatorSocket(
  deps: CogitatorDeps,
  caller: CallerHook,
  admitted: ReturnType<typeof anonymousHook>,
  options: WebSocketOptions = {}
) {
  const maxRuns = positiveInteger('maxRuns', options.maxRuns, DEFAULT_MAX_SOCKET_RUNS);
  const maxBufferedBytes = positiveInteger(
    'maxBufferedBytes',
    options.maxBufferedBytes,
    DEFAULT_MAX_BUFFERED_BYTES
  );
  const sockets = new WeakMap<object, SocketState>();
  const stateOf = (socket: OutboxSocket): SocketState => {
    let state = sockets.get(socket);
    if (!state) {
      state = {
        runs: new Map(),
        stopping: new Set(),
        outbox: new SocketOutbox(socket, maxBufferedBytes),
      };
      sockets.set(socket, state);
    }
    return state;
  };

  return ws({
    path: options.path ?? DEFAULT_PATH,
    hooks: { beforeParse: [caller, admitted, connectionDeps(deps)] },
    schema: { message: requestSchemas(deps).SocketMessage },
    docs: {
      summary: 'Run agents, workflows and swarms over a WebSocket',
      description:
        'Send `{ type: "run", id, payload: { type, name, input } }`, `{ type: "resume", id, payload: { name, threadId, decisions, responses } }` to continue an agent run paused for approvals or questions, `{ type: "stop", id }` or `{ type: "ping" }`. Runs with different ids go on side by side.',
    },
    until: () => resolveSignal(deps.until),
    message: (socket, message) => {
      const state = stateOf(socket);
      const { runs, stopping, outbox } = state;
      switch (message.type) {
        case 'ping':
          outbox.send({ type: 'pong', id: message.id });
          return;
        case 'stop':
          if (message.id === undefined) for (const id of [...runs.keys()]) stopRun(state, id);
          else stopRun(state, message.id);
          return;
        case 'run':
        case 'resume': {
          const refusal = runs.has(message.id)
            ? { error: alreadyRunning(message.id), code: 'RUN_IN_PROGRESS' }
            : runs.size + stopping.size >= maxRuns
              ? {
                  error: `The socket already has ${maxRuns} runs going: stop one or wait for it to end`,
                  code: 'TOO_MANY_RUNS',
                }
              : undefined;
          if (refusal) {
            outbox.send({ type: 'error', id: message.id, ...refusal });
            return;
          }
          const controller = new AbortController();
          runs.set(message.id, controller);
          const connection: Caller = {
            auth: socket.data.cogitatorAuth,
            runDeps: socket.data.cogitatorDeps,
          };
          return handleRun(deps, outbox, message, connection, controller.signal).finally(() => {
            if (runs.get(message.id) === controller) runs.delete(message.id);
            stopping.delete(controller);
          });
        }
      }
    },
    invalid: (socket, issues: readonly ValidationIssue[]) => {
      stateOf(socket).outbox.send({
        type: 'error',
        error: issues[0]?.message ?? 'Invalid message',
        code: 'INVALID_MESSAGE',
      });
    },
    drain: (socket) => {
      sockets.get(socket)?.outbox.drain();
    },
    close: (socket) => {
      const state = sockets.get(socket);
      if (!state) return;
      state.outbox.close();
      for (const id of [...state.runs.keys()]) stopRun(state, id);
    },
  });
}

/** Who opened a connection, and the `deps` the handshake built for its agent runs */
interface Caller {
  auth: AuthContext | undefined;
  runDeps: RunDeps;
}

/**
 * Runs one frame's run. A stop answers `cancelled` at once and silences the run from then on,
 * even when what runs notices the abort only later, such as a workflow node that is still
 * running: its `id` is free for a new run at once, and it counts toward `maxRuns` until it
 * actually ends.
 */
async function handleRun(
  deps: CogitatorDeps,
  outbox: SocketOutbox,
  message: RunMessage,
  caller: Caller,
  signal: AbortSignal
): Promise<void> {
  const id = message.id;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    outbox.send({ type: 'event', id, payload: { type: 'cancelled' } });
  };
  const emit: Emit = (event) => {
    if (!cancelled) outbox.send({ type: 'event', id, payload: event });
  };
  signal.addEventListener('abort', cancel, { once: true });

  try {
    const result =
      message.type === 'resume'
        ? await resume(deps, message.payload, caller, signal, emit)
        : await execute(deps, message.payload, caller, signal, emit);
    emit({ type: 'complete', result });
  } catch (error) {
    if (signal.aborted) return;
    const described = describeError(error);
    outbox.send({ type: 'error', id, error: described.message, code: described.code });
    if (described.unexpected) throw unwrapWorkflowFailure(error);
  } finally {
    signal.removeEventListener('abort', cancel);
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
  { auth, runDeps }: Caller,
  signal: AbortSignal,
  emit: Emit
): Promise<unknown> {
  const agent = findAgent(deps, payload.name);
  await checkThreadAccess(deps, auth, payload.threadId);
  const result = await resumeAgent(
    deps,
    agent,
    payload.threadId,
    { ...toResumeOptions(payload), ...agentCallbacks(signal, emit) },
    auth,
    runDeps
  );
  return toAgentRunResponse(result);
}

async function execute(
  deps: CogitatorDeps,
  payload: RunPayload,
  { auth, runDeps }: Caller,
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
          ...runRequestRunOptions(payload),
          ...agentCallbacks(signal, emit),
        },
        auth,
        runDeps
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
      return executeSwarm(
        deps,
        config,
        { input: payload.input, context: payload.context, threadId: payload.threadId },
        auth,
        signal,
        toSwarmRunResponse
      );
    }
  }
}
