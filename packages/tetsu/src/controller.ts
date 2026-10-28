import { controller, reportFailure, route } from '@tetsujs/core';
import type { BaseCtx } from '@tetsujs/core';
import { sse } from '@tetsujs/sse';
import type { ServerSentEvent } from '@tetsujs/sse';
import { countMessageTokens } from '@cogitator-ai/memory';
import {
  AgentStreamSession,
  ResumableStreams,
  STREAM_NOT_FOUND,
  checkRunLimits,
  createErrorEvent,
  createFinishEvent,
  createStartEvent,
  createSwarmEvent,
  createWorkflowEvent,
  generateId,
  readThreadPage,
  resolveSseHeartbeatMs,
  toAgentRunResponse,
  toWorkflowCompletedData,
  toWorkflowFailedData,
} from '@cogitator-ai/server-shared';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import {
  parseAGUIRunInput,
  streamAGUIRun,
  type AGUIRunHost,
  type AGUIRunRequest,
} from '@cogitator-ai/server-shared/agui';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import type {
  Message,
  RunResult,
  SwarmConfig,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import { httpError } from '@tetsujs/core';
import type { z } from 'zod';
import { anonymousHook, resolveCaller } from './auth.js';
import { holdConnection, jsonBody } from './connection.js';
import {
  clientClosedRequest,
  cogitatorErrors,
  refusalError,
  describeError,
  WorkflowRunFailedError,
  workflowRouteError,
} from './errors.js';
import {
  checkThreadAccess,
  checkWorkflowCheckpoint,
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
  resumeWorkflow,
  runAgent,
  runDepsOf,
  serializeSwarmUsage,
  toResumeOptions,
  toSwarmRunResponse,
  toWorkflowRunResponse,
} from './operations.js';
import {
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
  StreamParams,
  AGUIRunBody,
  ResumeBody,
  RUN_FAILURES,
  requestSchemas,
  WORKFLOW_RUN_FAILURES,
  SwarmListResponse,
  SwarmRunResponse,
  ThreadParams,
  ThreadQuery,
  ThreadResponse,
  ToolListResponse,
  WorkflowListResponse,
  WorkflowRunResponse,
} from './schemas.js';
import { reconnectHook, resumableEvents, streamCaller } from './resumable.js';
import { cogitatorSocket } from './socket.js';
import { triggerRoutes } from './triggers.js';
import { DONE_EVENT, eventsOf, resolveSignal, sseEvent } from './streaming.js';
import type { AgentStreamCallbacks } from './streaming.js';
import type { AuthContext, CogitatorDeps } from './types.js';

const AgentNotFound = errorEnvelope('AGENT_NOT_FOUND', 'No agent is registered under this name');
const WorkflowNotFound = errorEnvelope(
  'WORKFLOW_NOT_FOUND',
  'No workflow is registered under this name'
);
const WorkflowResumeNotFound = failureEnvelope(
  404,
  'No workflow is registered under this name, no checkpoint of it belongs to the caller (`CHECKPOINT_NOT_FOUND`), or a node called an agent or tool that does not exist'
);
const WorkflowStreamResumeNotFound = errorsEnvelope(
  ['WORKFLOW_NOT_FOUND', 'CHECKPOINT_NOT_FOUND'],
  'No workflow is registered under this name, or no checkpoint of it belongs to the caller'
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
  "The thread has no paused run (`RUN_NOT_PAUSED`), the agent is already running, or the resumed run met another run of the thread: the server's `multitaskStrategy` is `reject` (`THREAD_BUSY`), or a newer run stopped it (`RUN_INTERRUPTED`)"
);
const InterruptExpired = failureEnvelope(
  410,
  'An interrupt the resume answers expired before the answer came (`INTERRUPT_EXPIRED`)'
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

const RESUMABLE_STREAM_DESCRIPTION =
  'Every event carries an `id` (`<streamId>:<seq>`). A client that loses the stream sends the same request with `Last-Event-ID` (or `?lastEventId=`) set to the last id it got: the answer replays the events after it and follows the run, which went on without the client, to its end. Events no longer kept end the reconnect with an `error` event `STREAM_RESUME_GAP`: read the thread to catch up.';

const AGENT_STREAM_DESCRIPTION = `${STREAM_DESCRIPTION} The \`finish\` event carries the run usage, the same as \`usage\` in the JSON response of \`/run\`, with the reasoning and cache token counts the model reported. The stream is open before the run meets the other runs of its thread, so a run refused or stopped by one (\`THREAD_BUSY\`, \`RUN_INTERRUPTED\`) and a resume that answers an expired interrupt (\`INTERRUPT_EXPIRED\`) end it with an \`error\` event carrying that code, where \`/run\` and \`/resume\` answer 409 and 410.`;

type RequestSchemas = ReturnType<typeof requestSchemas>;
type SwarmRunRequest = z.output<RequestSchemas['SwarmRunBody']>;

/** Starts or resumes an agent run on `threadId` with the callbacks of a stream. */
type StreamedRun = (callbacks: AgentStreamCallbacks, threadId: string) => Promise<RunResult>;

/** Runs or resumes a workflow with the node callbacks of a stream. */
type StreamedWorkflow = (
  callbacks: WorkflowExecuteOptions
) => Promise<WorkflowResult<WorkflowState>>;

const NotJson = errorEnvelope(
  'UNSUPPORTED_MEDIA_TYPE',
  'The body is not JSON: only `application/json` bodies are read'
);

/** The `2xx` of an SSE route: a `text/event-stream` body the JSON document cannot describe. */
const StreamOpened = null;

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
  checkRunLimits(deps.limits);
  const caller = resolveCaller(deps.auth);
  const admitted = anonymousHook(deps.anonymous);
  const errors = cogitatorErrors();
  const heartbeatMs = resolveSseHeartbeatMs(deps.sseHeartbeatMs);
  const {
    RunBody,
    SwarmRunBody,
    WorkflowRunBody,
    WorkflowResumeBody,
    AddMessageBody,
    ReconnectHeaders,
    ReconnectQuery,
  } = requestSchemas(deps);
  const streamOptions = () => ({ until: resolveSignal(deps.until), heartbeatMs });
  const streams = ResumableStreams.from<AuthContext>(deps.resumableStreams);
  const reconnect = reconnectHook(deps, streams, streamOptions);
  const StreamAgentNotFound = streams
    ? errorsEnvelope(
        ['AGENT_NOT_FOUND', STREAM_NOT_FOUND],
        "No agent is registered under this name, or the stream a reconnect names is unknown, expired or not the caller's"
      )
    : AgentNotFound;
  const agentStreamDescription = streams
    ? `${AGENT_STREAM_DESCRIPTION} ${RESUMABLE_STREAM_DESCRIPTION}`
    : AGENT_STREAM_DESCRIPTION;

  /**
   * Streams an agent run or resume: on a resumable stream the run outlives the request, and
   * the request follows it like any client that reconnects
   */
  const agentStream = async (
    ctx: BaseCtx,
    start: StreamedRun,
    threadId: string | undefined,
    auth: AuthContext | undefined
  ): Promise<Response> => {
    if (!streams) {
      return sse(ctx, (signal) => agentEvents(start, signal, threadId), streamOptions());
    }
    const opened = await streams.startAgentRun({
      auth,
      threadId,
      signal: resolveSignal(deps.until),
      execute: (session, signal) =>
        start({ stream: true, signal, ...session.callbacks }, session.threadId),
      describeError: (error) => {
        const described = describeError(error);
        if (described.unexpected) reportFailure(ctx, 'stream', error);
        return described;
      },
    });
    if (!opened.ok) throw refusalError(opened.error);
    return sse(ctx, (signal) => resumableEvents(opened.stream, signal), streamOptions());
  };

  const memoryOf = async () => {
    const memory = await deps.cogitator.getMemory();
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
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
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
          415: NotJson,
          ...RUN_FAILURES,
          200: AgentRunResponse,
          403: ThreadForbidden,
          404: RunNotFound,
        },
      },
      hooks: {
        beforeParse: [caller, admitted, jsonBody],
        beforeHandle: [holdConnection],
        onError: [errors],
      },
      docs: { summary: 'Run an agent and wait for its answer', tags: ['agents'] },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        await checkThreadAccess(deps, ctx.cogitatorAuth, ctx.body.threadId);
        const runDeps = await runDepsOf(deps, ctx);
        const signal = ctx.req.signal;
        try {
          const result = await runAgent(
            deps,
            agent,
            { ...ctx.body, signal },
            ctx.cogitatorAuth,
            runDeps
          );
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
        headers: ReconnectHeaders,
        query: ReconnectQuery,
        body: RunBody,
        response: {
          200: StreamOpened,
          403: ThreadForbidden,
          404: StreamAgentNotFound,
          415: NotJson,
        },
      },
      hooks: { beforeParse: [caller, admitted, reconnect, jsonBody], onError: [errors] },
      docs: {
        summary: 'Run an agent and stream tokens, tool calls and results',
        description: agentStreamDescription,
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const auth = ctx.cogitatorAuth;
        const body = ctx.body;
        await checkThreadAccess(deps, auth, body.threadId);
        const runDeps = await runDepsOf(deps, ctx);
        return agentStream(
          ctx,
          (callbacks, threadId) =>
            runAgent(deps, agent, { ...body, threadId, ...callbacks }, auth, runDeps),
          body.threadId,
          auth
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
          415: NotJson,
          ...RUN_FAILURES,
          200: AgentRunResponse,
          403: ResumeForbidden,
          404: RunNotFound,
          409: ResumeConflict,
          410: InterruptExpired,
        },
      },
      hooks: {
        beforeParse: [caller, admitted, jsonBody],
        beforeHandle: [holdConnection],
        onError: [errors],
      },
      docs: {
        summary: 'Resume a run paused for tool approvals or questions and wait for its answer',
        description:
          'Approved calls run, declined ones answer the model with the reason, and calls without a decision pause the run again. The answers in `responses` go to the questions the tools asked, by interrupt id.',
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const { threadId } = ctx.body;
        await checkThreadAccess(deps, ctx.cogitatorAuth, threadId);
        const runDeps = await runDepsOf(deps, ctx);
        const signal = ctx.req.signal;
        try {
          const result = await resumeAgent(
            deps,
            agent,
            threadId,
            { ...toResumeOptions(ctx.body), signal },
            ctx.cogitatorAuth,
            runDeps
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
        headers: ReconnectHeaders,
        query: ReconnectQuery,
        body: ResumeBody,
        response: {
          200: StreamOpened,
          403: ThreadForbidden,
          404: StreamAgentNotFound,
          415: NotJson,
        },
      },
      hooks: { beforeParse: [caller, admitted, reconnect, jsonBody], onError: [errors] },
      docs: {
        summary: 'Resume a run paused for tool approvals or questions and stream the rest of it',
        description: agentStreamDescription,
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const auth = ctx.cogitatorAuth;
        const { threadId } = ctx.body;
        const resumeOptions = toResumeOptions(ctx.body);
        await checkThreadAccess(deps, auth, threadId);
        const runDeps = await runDepsOf(deps, ctx);
        return agentStream(
          ctx,
          (callbacks) =>
            resumeAgent(deps, agent, threadId, { ...resumeOptions, ...callbacks }, auth, runDeps),
          threadId,
          auth
        );
      },
    }),

    aguiAgent: route({
      method: 'POST',
      path: '/agents/:name/agui',
      schema: {
        params: NameParams,
        body: AGUIRunBody,
        response: { 200: StreamOpened, 403: ThreadForbidden, 415: NotJson },
      },
      hooks: { beforeParse: [caller, admitted, jsonBody], onError: [errors] },
      docs: {
        summary: 'Run or resume an agent for an AG-UI client and stream AG-UI events',
        description:
          "Takes an AG-UI 1.0 `RunAgentInput` and streams the run as AG-UI events over SSE, for CopilotKit or an `@ag-ui/client` `HttpAgent`. The AG-UI thread is the run's memory thread: the last message, which must be the user's, starts a new turn, `resume` entries answer every interrupt of the paused run at once. `state` is the run's state, `context` its brief.",
        tags: ['agents'],
      },
      handler: async (ctx) => {
        const agent = findAgent(deps, ctx.params.name);
        const parsed = parseAGUIRunInput(ctx.body);
        if (!parsed.ok) throw httpError(400, 'INVALID_INPUT', parsed.message);
        const auth = ctx.cogitatorAuth;
        const threadId = parsed.value.input.threadId;
        await checkThreadAccess(deps, auth, threadId);
        const runDeps = await runDepsOf(deps, ctx);
        const userId = auth?.userId;
        const host: AGUIRunHost = {
          run: (options) => runAgent(deps, agent, options, auth, runDeps),
          resume: (options) => resumeAgent(deps, agent, threadId, options, auth, runDeps),
          pausedRun: () => deps.cogitator.pausedRun(threadId),
          cancelPause: (reason) =>
            deps.cogitator.cancelPause(threadId, {
              ...(userId !== undefined && { userId }),
              reason,
            }),
        };
        const describe = (error: unknown) => {
          const described = describeError(error);
          if (described.unexpected) reportFailure(ctx, 'stream', error);
          return described;
        };
        return sse(
          ctx,
          (signal) => aguiEvents(parsed.value, host, signal, describe),
          streamOptions()
        );
      },
    }),

    getThread: route({
      method: 'GET',
      path: '/threads/:id',
      schema: {
        params: ThreadParams,
        query: ThreadQuery,
        response: {
          200: ThreadResponse,
          403: ThreadForbidden,
          500: ThreadUnreadable,
          503: MemoryNotConfigured,
        },
      },
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
      docs: {
        summary: 'Read the messages of a memory thread',
        description:
          'The whole thread, or with `limit` its newest messages and a `nextCursor`: pass it as `cursor` to read the page before, until an answer has no `nextCursor`.',
        tags: ['threads'],
      },
      handler: async (ctx) => {
        const memory = await memoryOf();
        const id = ctx.params.id;
        await checkThreadAccess(deps, ctx.cogitatorAuth, id);
        const thread = await assertThreadAccess(memory, id, ctx.cogitatorAuth?.userId);
        return readThreadPage(memory, id, ctx.query, thread);
      },
    }),

    addThreadMessage: route({
      method: 'POST',
      path: '/threads/:id/messages',
      schema: {
        params: ThreadParams,
        body: AddMessageBody,
        response: {
          415: NotJson,
          201: AddMessageResponse,
          403: ThreadForbidden,
          500: ThreadUnwritable,
          503: MemoryNotConfigured,
        },
      },
      hooks: { beforeParse: [caller, admitted, jsonBody], onError: [errors] },
      docs: {
        summary: 'Append a message to a memory thread',
        description: 'A thread that does not exist yet is created, owned by the caller.',
        tags: ['threads'],
      },
      handler: async (ctx) => {
        const accepted = ctx.body;
        const memory = await memoryOf();
        const id = ctx.params.id;
        await checkThreadAccess(deps, ctx.cogitatorAuth, id);
        await ensureThreadAccess(memory, id, { agentId: '', userId: ctx.cogitatorAuth?.userId });
        const message: Message = { role: accepted.role, content: accepted.content };
        const result = await memory.addEntry({
          threadId: id,
          message,
          tokenCount: countMessageTokens(message),
          ...(accepted.metadata && { metadata: accepted.metadata }),
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
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
      docs: { summary: 'Delete a memory thread', tags: ['threads'] },
      handler: async (ctx) => {
        const memory = await memoryOf();
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
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
      docs: { summary: 'List the tools of every agent', tags: ['agents'] },
      handler: () => listTools(deps),
    }),

    listWorkflows: route({
      method: 'GET',
      path: '/workflows',
      schema: { response: WorkflowListResponse },
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
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
          415: NotJson,
          ...WORKFLOW_RUN_FAILURES,
          200: WorkflowRunResponse,
          404: RunNotFound,
          501: NotImplemented,
        },
      },
      hooks: {
        beforeParse: [caller, admitted, jsonBody],
        beforeHandle: [holdConnection],
        onError: [errors],
      },
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
            signal,
            ctx.cogitatorAuth
          );
          return toWorkflowRunResponse(result);
        } catch (error) {
          if (signal.aborted) throw clientClosedRequest();
          throw workflowRouteError(error);
        }
      },
    }),

    streamWorkflow: route({
      method: 'POST',
      path: '/workflows/:name/stream',
      schema: {
        params: NameParams,
        body: WorkflowRunBody,
        response: { 200: StreamOpened, 404: WorkflowNotFound, 415: NotJson },
      },
      hooks: { beforeParse: [caller, admitted, jsonBody], onError: [errors] },
      docs: {
        summary: 'Run a workflow and stream node events',
        description: STREAM_DESCRIPTION,
        tags: ['workflows'],
      },
      handler: (ctx) => {
        const workflow = findWorkflow(deps, ctx.params.name);
        const { input, options } = ctx.body;
        const auth = ctx.cogitatorAuth;
        return sse(
          ctx,
          (signal) =>
            workflowEvents(
              (callbacks) =>
                executeWorkflow(deps, workflow, input, { ...options, ...callbacks }, signal, auth),
              signal
            ),
          streamOptions()
        );
      },
    }),

    resumeWorkflow: route({
      method: 'POST',
      path: '/workflows/:name/resume',
      schema: {
        params: NameParams,
        body: WorkflowResumeBody,
        response: {
          415: NotJson,
          ...WORKFLOW_RUN_FAILURES,
          200: WorkflowRunResponse,
          404: WorkflowResumeNotFound,
          501: NotImplemented,
        },
      },
      hooks: {
        beforeParse: [caller, admitted, jsonBody],
        beforeHandle: [holdConnection],
        onError: [errors],
      },
      docs: {
        summary: 'Resume a workflow from a checkpoint and wait for its final state',
        description:
          'The nodes the checkpoint completed are passed over, the rest run. Only a checkpoint of this workflow saved for the caller resumes, any other answers `404 CHECKPOINT_NOT_FOUND`.',
        tags: ['workflows'],
      },
      handler: async (ctx) => {
        const workflow = findWorkflow(deps, ctx.params.name);
        const { checkpointId, options } = ctx.body;
        const auth = ctx.cogitatorAuth;
        await checkWorkflowCheckpoint(deps, workflow, checkpointId, auth);
        const signal = ctx.req.signal;
        try {
          const result = await resumeWorkflow(
            deps,
            workflow,
            checkpointId,
            options ?? {},
            signal,
            auth
          );
          return toWorkflowRunResponse(result);
        } catch (error) {
          if (signal.aborted) throw clientClosedRequest();
          throw workflowRouteError(error);
        }
      },
    }),

    streamResumeWorkflow: route({
      method: 'POST',
      path: '/workflows/:name/resume/stream',
      schema: {
        params: NameParams,
        body: WorkflowResumeBody,
        response: { 200: StreamOpened, 404: WorkflowStreamResumeNotFound, 415: NotJson },
      },
      hooks: { beforeParse: [caller, admitted, jsonBody], onError: [errors] },
      docs: {
        summary: 'Resume a workflow from a checkpoint and stream node events',
        description: `${STREAM_DESCRIPTION} A checkpoint that is not one of this workflow saved for the caller answers \`404 CHECKPOINT_NOT_FOUND\` before the stream opens.`,
        tags: ['workflows'],
      },
      handler: async (ctx) => {
        const workflow = findWorkflow(deps, ctx.params.name);
        const { checkpointId, options } = ctx.body;
        const auth = ctx.cogitatorAuth;
        await checkWorkflowCheckpoint(deps, workflow, checkpointId, auth);
        return sse(
          ctx,
          (signal) =>
            workflowEvents(
              (callbacks) =>
                resumeWorkflow(
                  deps,
                  workflow,
                  checkpointId,
                  { ...options, ...callbacks },
                  signal,
                  auth
                ),
              signal
            ),
          streamOptions()
        );
      },
    }),

    listSwarms: route({
      method: 'GET',
      path: '/swarms',
      schema: { response: SwarmListResponse },
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
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
          415: NotJson,
          ...RUN_FAILURES,
          200: SwarmRunResponse,
          403: ThreadForbidden,
          404: RunNotFound,
          501: NotImplemented,
        },
      },
      hooks: {
        beforeParse: [caller, admitted, jsonBody],
        beforeHandle: [holdConnection],
        onError: [errors],
      },
      docs: { summary: 'Run a swarm and wait for its result', tags: ['swarms'] },
      handler: async (ctx) => {
        const config = findSwarm(deps, ctx.params.name);
        await checkThreadAccess(deps, ctx.cogitatorAuth, ctx.body.threadId);
        const signal = ctx.req.signal;
        try {
          const response = await executeSwarm(
            deps,
            config,
            ctx.body,
            ctx.cogitatorAuth,
            signal,
            toSwarmRunResponse
          );
          if (signal.aborted) throw clientClosedRequest();
          return response;
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
        response: { 200: StreamOpened, 403: ThreadForbidden, 404: SwarmNotFound, 415: NotJson },
      },
      hooks: { beforeParse: [caller, admitted, jsonBody], onError: [errors] },
      docs: {
        summary: 'Run a swarm and stream agent events',
        description: STREAM_DESCRIPTION,
        tags: ['swarms'],
      },
      handler: async (ctx) => {
        const config = findSwarm(deps, ctx.params.name);
        const body = ctx.body;
        await checkThreadAccess(deps, ctx.cogitatorAuth, body.threadId);
        return sse(
          ctx,
          (signal) => swarmEvents(deps, config, body, ctx.cogitatorAuth, signal),
          streamOptions()
        );
      },
    }),

    getBlackboard: route({
      method: 'GET',
      path: '/swarms/:name/blackboard',
      schema: {
        params: NameParams,
        response: { 200: BlackboardResponse, 404: SwarmNotFound, 409: BlackboardDisabled },
      },
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
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
    ? cogitatorSocket(deps, caller, admitted, deps.websocket === true ? undefined : deps.websocket)
    : undefined;
  const cancelAgentStream =
    streams &&
    route({
      method: 'DELETE',
      path: '/agents/:name/stream/:streamId',
      schema: {
        params: StreamParams,
        response: { 204: null, 403: ThreadForbidden, 404: StreamAgentNotFound },
      },
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
      docs: {
        summary: 'Cancel the run of a resumable stream',
        description:
          'Stops the run of a stream, on whatever process runs it: the stream ends with an `error` event `STREAM_CANCELLED`. Only the caller who started the stream may cancel its run, after `authorizeThread` on its thread. A stream that already finished is left as it is.',
        tags: ['agents'],
      },
      handler: async (ctx) => {
        findAgent(deps, ctx.params.name);
        const cancelled = await streams.cancel(
          ctx.params.streamId,
          streamCaller(deps, ctx.cogitatorAuth)
        );
        if (!cancelled.ok) throw refusalError(cancelled.error);
      },
    });
  const triggers =
    deps.triggers &&
    triggerRoutes(deps.triggers, { caller, admitted, errors, anonymous: deps.anonymous });
  return {
    ...routes,
    ...(cancelAgentStream && { cancelAgentStream }),
    ...triggers,
    ...(socket && { socket }),
  };
});

function* failure(error: unknown): Generator<ServerSentEvent, void, undefined> {
  const described = describeError(error);
  yield sseEvent(createErrorEvent(described.message, described.code));
  if (described.unexpected) throw error;
}

/**
 * The events of a streamed agent run or resume, as every adapter sends them: the thread in
 * `start` and `finish`, text and reasoning parts closed before a tool call, the answer the
 * model gave in one piece, `approval-required` when it pauses for approvals or
 * `interrupt-required` when it pauses for questions its tools asked, and `[DONE]` after `finish`.
 */
async function* agentEvents(
  start: StreamedRun,
  signal: AbortSignal,
  threadId: string | undefined
): AsyncGenerator<ServerSentEvent, void, undefined> {
  let sink: (event: StreamEvent) => void = () => undefined;
  const session = new AgentStreamSession((event) => sink(event), { threadId });

  try {
    yield* eventsOf<ServerSentEvent>(signal, async (emit) => {
      sink = (event) => {
        emit(sseEvent(event));
        if (event.type === 'finish') emit(DONE_EVENT);
      };
      session.start();
      const result = await start({ stream: true, signal, ...session.callbacks }, session.threadId);
      session.complete(result);
    });
  } catch (error) {
    if (signal.aborted) return;
    const described = describeError(error);
    const closing: StreamEvent[] = [];
    sink = (event) => closing.push(event);
    session.fail(described.message, described.code);
    yield* closing.map(sseEvent);
    if (described.unexpected) throw error;
  }
}

/** The AG-UI events of a run or resume an AG-UI client asked for, see `streamAGUIRun()` */
async function* aguiEvents(
  request: AGUIRunRequest,
  host: AGUIRunHost,
  signal: AbortSignal,
  describe: (error: unknown) => { message: string; code: string }
): AsyncGenerator<ServerSentEvent, void, undefined> {
  yield* eventsOf<ServerSentEvent>(signal, (emit) =>
    streamAGUIRun({
      request,
      host,
      signal,
      send: (event) => emit({ data: event }),
      describeError: describe,
    })
  );
}

async function* workflowEvents(
  start: StreamedWorkflow,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const messageId = generateId('wf');
  let result: WorkflowResult<WorkflowState> | undefined;

  yield sseEvent(createStartEvent(messageId));

  try {
    yield* eventsOf<ServerSentEvent>(signal, async (emit) => {
      const event = (name: string, data: unknown) =>
        emit(sseEvent(createWorkflowEvent(name, data)));
      result = await start({
        onNodeStart: (nodeName) => event('node_started', { nodeName, timestamp: Date.now() }),
        onNodeComplete: (nodeName, output, duration) =>
          event('node_completed', { nodeName, output, duration }),
        onNodeError: (nodeName, error) =>
          event('node_error', { nodeName, error: describeError(error).message }),
        onNodeProgress: (nodeName, progress) => event('node_progress', { nodeName, progress }),
      });
    });
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof WorkflowRunFailedError) {
      yield sseEvent(createWorkflowEvent('workflow_failed', toWorkflowFailedData(error)));
      yield* failure(error.failure);
      return;
    }
    yield* failure(error);
    return;
  }

  if (signal.aborted || !result) return;
  yield sseEvent(createWorkflowEvent('workflow_completed', toWorkflowCompletedData(result)));
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
  let completed: StreamEvent | undefined;

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
            event('agent_error', { agentName, error: describeError(error).message }),
          onMessage: (message) => event('message', message),
          onEvent: (swarmEvent) => event(swarmEvent.type, swarmEvent.data),
        },
        auth,
        signal,
        (swarm, result) =>
          createSwarmEvent('swarm_completed', {
            swarmId: swarm.id,
            output: result.output,
            usage: serializeSwarmUsage(swarm.getResourceUsage()),
          })
      );
    });
  } catch (error) {
    if (signal.aborted) return;
    yield* failure(error);
    return;
  }

  if (signal.aborted || !completed) return;
  yield sseEvent(completed);
  yield sseEvent(createFinishEvent(messageId));
  yield DONE_EVENT;
}
