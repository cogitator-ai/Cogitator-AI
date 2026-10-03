import { controller, route } from '@tetsujs/core';
import { sse } from '@tetsujs/sse';
import type { ServerSentEvent } from '@tetsujs/sse';
import { countMessageTokens } from '@cogitator-ai/memory';
import {
  createApprovalRequiredEvent,
  createErrorEvent,
  createFinishEvent,
  createStartEvent,
  createSwarmEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolCallStartEvent,
  createToolResultEvent,
  createWorkflowEvent,
  generateId,
} from '@cogitator-ai/server-shared';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import type {
  Message,
  RunResult,
  SwarmConfig,
  Workflow,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import { httpError } from '@tetsujs/core';
import type { z } from 'zod';
import { resolveCaller } from './auth.js';
import { clientClosedRequest, cogitatorErrors, describeError } from './errors.js';
import {
  checkThreadAccess,
  executeSwarm,
  executeWorkflow,
  findAgent,
  findSwarm,
  findWorkflow,
  listAgents,
  listSwarms,
  listTools,
  listWorkflows,
  resumeAgent,
  runAgent,
  serializeSwarmUsage,
  toAgentRunResponse,
  toPendingApprovals,
  toResumeDecisions,
  toSwarmRunResponse,
  toWorkflowRunResponse,
} from './operations.js';
import {
  AddMessageBody,
  AddMessageResponse,
  AgentListResponse,
  AgentRunResponse,
  BlackboardResponse,
  errorEnvelope,
  errorsEnvelope,
  failureEnvelope,
  HealthResponse,
  NameParams,
  ReadyResponse,
  ResumeBody,
  RUN_FAILURES,
  RunBody,
  SwarmListResponse,
  SwarmRunBody,
  SwarmRunResponse,
  ThreadParams,
  ThreadResponse,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowRunBody,
  WorkflowRunResponse,
} from './schemas.js';
import { cogitatorSocket } from './socket.js';
import { DONE_EVENT, eventsOf, MessageParts, resolveSignal, sseEvent } from './streaming.js';
import type { AgentStreamCallbacks } from './streaming.js';
import type { AuthContext, CogitatorDeps } from './types.js';

const AgentNotFound = errorEnvelope('AGENT_NOT_FOUND', 'No agent is registered under this name');
const WorkflowNotFound = errorEnvelope(
  'WORKFLOW_NOT_FOUND',
  'No workflow is registered under this name'
);
const SwarmNotFound = errorEnvelope('SWARM_NOT_FOUND', 'No swarm is registered under this name');
const RunNotFound = failureEnvelope(
  404,
  'No agent, workflow or swarm is registered under this name, or the agent called a tool it does not have',
  ['SWARM_NOT_FOUND']
);
const NotImplemented = failureEnvelope(
  501,
  'The optional package this endpoint needs is not installed',
  ['PACKAGE_NOT_INSTALLED']
);
const ThreadForbidden = failureEnvelope(
  403,
  'The memory thread belongs to another user, or `authorizeThread` refused it',
  ['THREAD_FORBIDDEN']
);
const ResumeForbidden = failureEnvelope(
  403,
  'The paused run belongs to another user, or `authorizeThread` refused the thread',
  ['THREAD_FORBIDDEN']
);
const ResumeConflict = failureEnvelope(
  409,
  'The thread has no paused run (`RUN_NOT_PAUSED`), or the agent is already running'
);
const ThreadUnreadable = errorsEnvelope(
  ['MEMORY_READ_FAILED'],
  'The memory adapter could not read the thread, so its owner is unknown'
);
const ThreadUnwritable = errorsEnvelope(
  ['MEMORY_READ_FAILED', 'MEMORY_WRITE_FAILED'],
  'The memory adapter could not read or create the thread'
);
const MemoryNotConfigured = errorEnvelope(
  'MEMORY_NOT_CONFIGURED',
  'The Cogitator runtime has no memory adapter'
);
const BlackboardDisabled = errorEnvelope(
  'BLACKBOARD_DISABLED',
  'The blackboard is not enabled for this swarm'
);

const STREAM_DESCRIPTION =
  'Server-sent events in the Cogitator stream protocol, one JSON event per `data:` line, ending with `data: [DONE]`.';

type SwarmRunRequest = z.output<typeof SwarmRunBody>;
type WorkflowRunRequest = z.output<typeof WorkflowRunBody>;

/** Starts or resumes an agent run with the callbacks of a stream. */
type StreamedRun = (callbacks: AgentStreamCallbacks) => Promise<RunResult>;

/**
 * The Cogitator HTTP API as a Tetsu controller.
 *
 * Mount it like any controller, usually under a group:
 *
 * @example
 * ```ts
 * const app = createApp({
 *   routes: [
 *     group('/cogitator', { children: [cogitatorController({ cogitator, agents: { chat } })] }),
 *     docs({ info: { title: 'Agents', version: '1.0.0' } }),
 *   ],
 * });
 *
 * Bun.serve({ ...app, port: 3000 });
 * ```
 */
export const cogitatorController = controller('Cogitator', (deps: CogitatorDeps) => {
  const builtAt = Date.now();
  const caller = resolveCaller(deps.auth);
  const errors = cogitatorErrors();
  const until = () => resolveSignal(deps.until);

  const memoryOf = () => {
    const memory = deps.cogitator.memory;
    if (!memory) {
      throw httpError(503, 'MEMORY_NOT_CONFIGURED', 'The Cogitator runtime has no memory adapter');
    }
    return memory;
  };

  const routes = {
    health: route({
      method: 'GET',
      path: '/health',
      schema: { response: HealthResponse },
      hooks: { onError: [errors] },
      docs: { summary: 'Liveness check', tags: ['health'] },
      handler: () => ({
        status: 'ok' as const,
        uptime: Date.now() - builtAt,
        timestamp: Date.now(),
      }),
    }),

    ready: route({
      method: 'GET',
      path: '/ready',
      schema: { response: ReadyResponse },
      hooks: { onError: [errors] },
      docs: { summary: 'Readiness check', tags: ['health'] },
      handler: () => ({ status: 'ok' as const }),
    }),

    listAgents: route({
      method: 'GET',
      path: '/agents',
      schema: { response: AgentListResponse },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'List agents', tags: ['agents'] },
      handler: () => listAgents(deps),
    }),

    runAgent: route({
      method: 'POST',
      path: '/agents/:name/run',
      schema: {
        params: NameParams,
        body: RunBody,
        response: {
          ...RUN_FAILURES,
          200: AgentRunResponse,
          403: ThreadForbidden,
          404: RunNotFound,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'Run an agent and wait for its answer', tags: ['agents'] },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        await checkThreadAccess(deps, ctx.cogitatorAuth, ctx.body.threadId);
        const signal = ctx.req.signal;
        try {
          const result = await runAgent(deps, agent, { ...ctx.body, signal }, ctx.cogitatorAuth);
          return toAgentRunResponse(result);
        } catch (error) {
          if (signal.aborted) throw clientClosedRequest();
          throw error;
        }
      },
    }),

    streamAgent: route({
      method: 'POST',
      path: '/agents/:name/stream',
      schema: {
        params: NameParams,
        body: RunBody,
        response: { 403: ThreadForbidden, 404: AgentNotFound },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: {
        summary: 'Run an agent and stream tokens, tool calls and results',
        description: STREAM_DESCRIPTION,
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const auth = ctx.cogitatorAuth;
        const body = ctx.body;
        await checkThreadAccess(deps, auth, body.threadId);
        return sse(
          ctx,
          (signal) =>
            agentEvents(
              (callbacks) => runAgent(deps, agent, { ...body, ...callbacks }, auth),
              signal
            ),
          { until: until() }
        );
      },
    }),

    resumeAgent: route({
      method: 'POST',
      path: '/agents/:name/resume',
      schema: {
        params: NameParams,
        body: ResumeBody,
        response: {
          ...RUN_FAILURES,
          200: AgentRunResponse,
          403: ResumeForbidden,
          404: RunNotFound,
          409: ResumeConflict,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: {
        summary: 'Resume a run paused for tool approvals and wait for its answer',
        description:
          'Approved calls run, declined ones answer the model with the reason, and calls without a decision pause the run again.',
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const { threadId } = ctx.body;
        await checkThreadAccess(deps, ctx.cogitatorAuth, threadId);
        const signal = ctx.req.signal;
        try {
          const result = await resumeAgent(
            deps,
            agent,
            threadId,
            { ...toResumeDecisions(ctx.body), signal },
            ctx.cogitatorAuth
          );
          return toAgentRunResponse(result);
        } catch (error) {
          if (signal.aborted) throw clientClosedRequest();
          throw error;
        }
      },
    }),

    streamResumeAgent: route({
      method: 'POST',
      path: '/agents/:name/resume/stream',
      schema: {
        params: NameParams,
        body: ResumeBody,
        response: { 403: ThreadForbidden, 404: AgentNotFound },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: {
        summary: 'Resume a run paused for tool approvals and stream the rest of it',
        description: STREAM_DESCRIPTION,
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const auth = ctx.cogitatorAuth;
        const { threadId } = ctx.body;
        const decisions = toResumeDecisions(ctx.body);
        await checkThreadAccess(deps, auth, threadId);
        return sse(
          ctx,
          (signal) =>
            agentEvents(
              (callbacks) =>
                resumeAgent(deps, agent, threadId, { ...decisions, ...callbacks }, auth),
              signal
            ),
          { until: until() }
        );
      },
    }),

    getThread: route({
      method: 'GET',
      path: '/threads/:id',
      schema: {
        params: ThreadParams,
        response: {
          200: ThreadResponse,
          403: ThreadForbidden,
          500: ThreadUnreadable,
          503: MemoryNotConfigured,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'Read the messages of a memory thread', tags: ['threads'] },
      handler: async (ctx) => {
        const memory = memoryOf();
        const id = ctx.params.id;
        await checkThreadAccess(deps, ctx.cogitatorAuth, id);
        await assertThreadAccess(memory, id, ctx.cogitatorAuth?.userId);
        const result = await memory.getEntries({ threadId: id });
        if (!result.success) throw new Error(result.error);
        const entries = result.data;
        const now = Date.now();
        return {
          id,
          messages: entries.map((entry) => entry.message),
          createdAt: entries.at(0)?.createdAt.getTime() ?? now,
          updatedAt: entries.at(-1)?.createdAt.getTime() ?? now,
        };
      },
    }),

    addThreadMessage: route({
      method: 'POST',
      path: '/threads/:id/messages',
      schema: {
        params: ThreadParams,
        body: AddMessageBody,
        response: {
          201: AddMessageResponse,
          403: ThreadForbidden,
          500: ThreadUnwritable,
          503: MemoryNotConfigured,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: {
        summary: 'Append a message to a memory thread',
        description: 'A thread that does not exist yet is created, owned by the caller.',
        tags: ['threads'],
      },
      handler: async (ctx) => {
        const memory = memoryOf();
        const id = ctx.params.id;
        await checkThreadAccess(deps, ctx.cogitatorAuth, id);
        await ensureThreadAccess(memory, id, { agentId: '', userId: ctx.cogitatorAuth?.userId });
        const message: Message = { role: ctx.body.role, content: ctx.body.content };
        const result = await memory.addEntry({
          threadId: id,
          message,
          tokenCount: countMessageTokens(message),
          ...(ctx.body.metadata && { metadata: ctx.body.metadata }),
        });
        if (!result.success) throw new Error(result.error);
        ctx.out.status = 201;
        return { success: true as const };
      },
    }),

    deleteThread: route({
      method: 'DELETE',
      path: '/threads/:id',
      schema: {
        params: ThreadParams,
        response: {
          204: null,
          403: ThreadForbidden,
          500: ThreadUnreadable,
          503: MemoryNotConfigured,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'Delete a memory thread', tags: ['threads'] },
      handler: async (ctx) => {
        const memory = memoryOf();
        const id = ctx.params.id;
        await checkThreadAccess(deps, ctx.cogitatorAuth, id);
        await assertThreadAccess(memory, id, ctx.cogitatorAuth?.userId);
        const result = await memory.clearThread(id);
        if (!result.success) throw new Error(result.error);
      },
    }),

    listTools: route({
      method: 'GET',
      path: '/tools',
      schema: { response: ToolListResponse },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'List the tools of every agent', tags: ['agents'] },
      handler: () => listTools(deps),
    }),

    listWorkflows: route({
      method: 'GET',
      path: '/workflows',
      schema: { response: WorkflowListResponse },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'List workflows', tags: ['workflows'] },
      handler: () => listWorkflows(deps),
    }),

    runWorkflow: route({
      method: 'POST',
      path: '/workflows/:name/run',
      schema: {
        params: NameParams,
        body: WorkflowRunBody,
        response: {
          ...RUN_FAILURES,
          200: WorkflowRunResponse,
          404: RunNotFound,
          501: NotImplemented,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'Run a workflow and wait for its final state', tags: ['workflows'] },
      handler: async (ctx) => {
        const workflow = findWorkflow(deps, ctx.params.name);
        const signal = ctx.req.signal;
        try {
          const result = await executeWorkflow(
            deps,
            workflow,
            ctx.body.input,
            ctx.body.options ?? {},
            signal
          );
          return toWorkflowRunResponse(result);
        } catch (error) {
          if (signal.aborted) throw clientClosedRequest();
          throw error;
        }
      },
    }),

    streamWorkflow: route({
      method: 'POST',
      path: '/workflows/:name/stream',
      schema: {
        params: NameParams,
        body: WorkflowRunBody,
        response: { 404: WorkflowNotFound },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: {
        summary: 'Run a workflow and stream node events',
        description: STREAM_DESCRIPTION,
        tags: ['workflows'],
      },
      handler: (ctx) => {
        const workflow = findWorkflow(deps, ctx.params.name);
        const body = ctx.body;
        return sse(ctx, (signal) => workflowEvents(deps, workflow, body, signal), {
          until: until(),
        });
      },
    }),

    listSwarms: route({
      method: 'GET',
      path: '/swarms',
      schema: { response: SwarmListResponse },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'List swarms', tags: ['swarms'] },
      handler: () => listSwarms(deps),
    }),

    runSwarm: route({
      method: 'POST',
      path: '/swarms/:name/run',
      schema: {
        params: NameParams,
        body: SwarmRunBody,
        response: {
          ...RUN_FAILURES,
          200: SwarmRunResponse,
          403: ThreadForbidden,
          404: RunNotFound,
          501: NotImplemented,
        },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'Run a swarm and wait for its result', tags: ['swarms'] },
      handler: async (ctx) => {
        const config = findSwarm(deps, ctx.params.name);
        await checkThreadAccess(deps, ctx.cogitatorAuth, ctx.body.threadId);
        const signal = ctx.req.signal;
        try {
          const { swarm, result } = await executeSwarm(
            deps,
            config,
            ctx.body,
            ctx.cogitatorAuth,
            signal
          );
          if (signal.aborted) throw clientClosedRequest();
          return toSwarmRunResponse(swarm, result);
        } catch (error) {
          if (signal.aborted) throw clientClosedRequest();
          throw error;
        }
      },
    }),

    streamSwarm: route({
      method: 'POST',
      path: '/swarms/:name/stream',
      schema: {
        params: NameParams,
        body: SwarmRunBody,
        response: { 403: ThreadForbidden, 404: SwarmNotFound },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: {
        summary: 'Run a swarm and stream agent events',
        description: STREAM_DESCRIPTION,
        tags: ['swarms'],
      },
      handler: async (ctx) => {
        const config = findSwarm(deps, ctx.params.name);
        const body = ctx.body;
        await checkThreadAccess(deps, ctx.cogitatorAuth, body.threadId);
        return sse(ctx, (signal) => swarmEvents(deps, config, body, ctx.cogitatorAuth, signal), {
          until: until(),
        });
      },
    }),

    getBlackboard: route({
      method: 'GET',
      path: '/swarms/:name/blackboard',
      schema: {
        params: NameParams,
        response: { 200: BlackboardResponse, 404: SwarmNotFound, 409: BlackboardDisabled },
      },
      hooks: { beforeParse: [caller], onError: [errors] },
      docs: { summary: 'Read the configured blackboard sections of a swarm', tags: ['swarms'] },
      handler: (ctx) => {
        const config = findSwarm(deps, ctx.params.name);
        if (!config.blackboard?.enabled) {
          throw httpError(
            409,
            'BLACKBOARD_DISABLED',
            'The blackboard is not enabled for this swarm'
          );
        }
        return { sections: config.blackboard.sections ?? {} };
      },
    }),
  };

  const socket = deps.websocket
    ? cogitatorSocket(deps, caller, deps.websocket === true ? undefined : deps.websocket.path)
    : undefined;
  return { ...routes, ...(socket && { socket }) };
});

function* failure(error: unknown): Generator<ServerSentEvent, void, undefined> {
  const described = describeError(error);
  yield sseEvent(createErrorEvent(described.message, described.code));
  if (described.unexpected) throw error;
}

async function* agentEvents(
  start: StreamedRun,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const messageId = generateId('msg');
  const parts = new MessageParts();
  let result: RunResult | undefined;

  yield sseEvent(createStartEvent(messageId));

  try {
    yield* eventsOf<ServerSentEvent>(signal, async (emit) => {
      const emitAll = (events: StreamEvent[]) => {
        for (const event of events) emit(sseEvent(event));
      };
      result = await start({
        stream: true,
        signal,
        onToken: (token) => emitAll(parts.delta('text', token)),
        onReasoning: (delta) => emitAll(parts.delta('reasoning', delta)),
        onToolCall: (call) => {
          emitAll(parts.end('reasoning'));
          emit(sseEvent(createToolCallStartEvent(call.id, call.name)));
          emit(sseEvent(createToolCallDeltaEvent(call.id, JSON.stringify(call.arguments))));
          emit(sseEvent(createToolCallEndEvent(call.id)));
        },
        onToolResult: (toolResult) => {
          emit(
            sseEvent(createToolResultEvent(generateId('res'), toolResult.callId, toolResult.result))
          );
        },
      });
    });
  } catch (error) {
    if (signal.aborted) return;
    yield* parts.end().map(sseEvent);
    yield* failure(error);
    return;
  }

  if (signal.aborted || !result) return;
  yield* parts.end().map(sseEvent);
  if (result.status === 'paused') {
    yield sseEvent(
      createApprovalRequiredEvent(
        result.threadId,
        toPendingApprovals(result.pendingApprovals ?? [])
      )
    );
  }
  yield sseEvent(
    createFinishEvent(messageId, {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    })
  );
  yield DONE_EVENT;
}

async function* workflowEvents(
  deps: CogitatorDeps,
  workflow: Workflow<WorkflowState>,
  body: WorkflowRunRequest,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const messageId = generateId('wf');
  let result: WorkflowResult<WorkflowState> | undefined;

  yield sseEvent(createStartEvent(messageId));

  try {
    yield* eventsOf<ServerSentEvent>(signal, async (emit) => {
      const event = (name: string, data: unknown) =>
        emit(sseEvent(createWorkflowEvent(name, data)));
      result = await executeWorkflow(
        deps,
        workflow,
        body.input,
        {
          ...body.options,
          onNodeStart: (nodeName) => event('node_started', { nodeName, timestamp: Date.now() }),
          onNodeComplete: (nodeName, output, duration) =>
            event('node_completed', { nodeName, output, duration }),
          onNodeError: (nodeName, error) => event('node_error', { nodeName, error: error.message }),
          onNodeProgress: (nodeName, progress) => event('node_progress', { nodeName, progress }),
        },
        signal
      );
    });
  } catch (error) {
    if (signal.aborted) return;
    yield* failure(error);
    return;
  }

  if (signal.aborted || !result) return;
  yield sseEvent(
    createWorkflowEvent('workflow_completed', {
      workflowId: result.workflowId,
      duration: result.duration,
    })
  );
  yield sseEvent(createFinishEvent(messageId));
  yield DONE_EVENT;
}

async function* swarmEvents(
  deps: CogitatorDeps,
  config: SwarmConfig,
  body: SwarmRunRequest,
  auth: AuthContext | undefined,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const messageId = generateId('swarm');
  let completed: Awaited<ReturnType<typeof executeSwarm>> | undefined;

  yield sseEvent(createStartEvent(messageId));

  try {
    yield* eventsOf<ServerSentEvent>(signal, async (emit) => {
      const event = (name: string, data: unknown) => emit(sseEvent(createSwarmEvent(name, data)));
      completed = await executeSwarm(
        deps,
        config,
        {
          ...body,
          onAgentStart: (agentName) => event('agent_start', { agentName, timestamp: Date.now() }),
          onAgentComplete: (agentName, agentResult) =>
            event('agent_complete', {
              agentName,
              output: agentResult.output,
              timestamp: Date.now(),
            }),
          onAgentError: (agentName, error) =>
            event('agent_error', { agentName, error: error.message }),
          onMessage: (message) => event('message', message),
          onEvent: (swarmEvent) => event(swarmEvent.type, swarmEvent.data),
        },
        auth,
        signal
      );
    });
  } catch (error) {
    if (signal.aborted) return;
    yield* failure(error);
    return;
  }

  if (signal.aborted || !completed) return;
  const { swarm, result } = completed;
  yield sseEvent(
    createSwarmEvent('swarm_completed', {
      swarmId: swarm.id,
      output: result.output,
      usage: serializeSwarmUsage(swarm.getResourceUsage()),
    })
  );
  yield sseEvent(createFinishEvent(messageId));
  yield DONE_EVENT;
}
