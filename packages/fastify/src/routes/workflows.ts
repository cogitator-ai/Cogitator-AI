import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CheckpointStore,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type {
  WorkflowListResponse,
  WorkflowResumeRequest,
  WorkflowRunRequest,
  WorkflowRunResponse,
} from '../types.js';
import { workflowResumeRequestSchema, workflowRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import {
  checkpointNotFound,
  findOwnedCheckpoint,
  ownedCheckpoints,
  parseWorkflowResumeRequest,
  parseWorkflowRunRequest,
  toWorkflowCompletedData,
  toWorkflowFailedData,
  withResumedCheckpoint,
  workflowOptionsWithin,
  workflowRunFailure,
} from '@cogitator-ai/server-shared';
import type { RunLimits } from '@cogitator-ai/server-shared';
import {
  isModuleNotFound,
  onClientDisconnect,
  resolveError,
  sendError,
  sendFailure,
  sendRouteError,
  validateBody,
} from './utils.js';

/**
 * The options of a workflow request the executor takes, held to the limits, and nothing else of
 * the body: the route schema strips unknown keys, and this does not rely on it
 */
function requestedOptions(
  options: { maxConcurrency?: number; maxIterations?: number; checkpoint?: boolean },
  limits: RunLimits | undefined
): WorkflowExecuteOptions {
  const held = workflowOptionsWithin(
    { maxConcurrency: options.maxConcurrency, maxIterations: options.maxIterations },
    limits
  );
  return {
    ...(held.maxConcurrency !== undefined && { maxConcurrency: held.maxConcurrency }),
    ...(held.maxIterations !== undefined && { maxIterations: held.maxIterations }),
    ...(options.checkpoint === true && { checkpoint: true }),
  };
}

interface WorkflowParams {
  name: string;
}

const paramsSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const;

const WORKFLOWS_MISSING = 'Workflows package not installed';

type WorkflowRunOptions = WorkflowExecuteOptions & { signal: AbortSignal };

/** Runs or resumes a workflow with the options of a request and the callbacks of its answer */
type WorkflowStart = (options: WorkflowRunOptions) => Promise<WorkflowResult<WorkflowState>>;

function toWorkflowRunResponse(result: WorkflowResult<WorkflowState>): WorkflowRunResponse {
  return {
    workflowId: result.workflowId,
    workflowName: result.workflowName,
    state: result.state,
    duration: result.duration,
    nodeResults: Object.fromEntries(result.nodeResults),
    ...(result.checkpointId !== undefined && { checkpointId: result.checkpointId }),
  };
}

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  const store = fastify.cogitator.workflowCheckpoints;
  const limits = fastify.cogitator.limits;

  const findWorkflow = (name: string) =>
    Object.hasOwn(fastify.cogitator.workflows, name)
      ? fastify.cogitator.workflows[name]
      : undefined;

  const executorFor = async (checkpoints: CheckpointStore | undefined) => {
    const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
    return new WorkflowExecutor(fastify.cogitator.runtime, checkpoints);
  };

  const runSchema = {
    params: paramsSchema,
    body: workflowRunRequestSchema(limits, store !== undefined),
  };
  const resumeSchema = {
    params: paramsSchema,
    body: workflowResumeRequestSchema(limits),
  };
  const runBody = validateBody((body) =>
    parseWorkflowRunRequest(body, { checkpoints: store !== undefined })
  );
  const resumeBody = validateBody(parseWorkflowResumeRequest);

  const startRun = (
    request: FastifyRequest<{ Params: WorkflowParams; Body: WorkflowRunRequest }>,
    reply: FastifyReply
  ): WorkflowStart | FastifyReply => {
    const { name } = request.params;
    const workflow = findWorkflow(name);
    if (!workflow) return sendError(reply, 404, `Workflow '${name}' not found`, 'NOT_FOUND');

    const { input, options = {} } = request.body ?? {};
    const checkpoints =
      options.checkpoint && store
        ? ownedCheckpoints(store, request.cogitatorAuth?.userId)
        : undefined;
    return async (runOptions) =>
      (await executorFor(checkpoints)).execute(workflow, input, {
        ...requestedOptions(options, limits),
        ...runOptions,
      });
  };

  const startResume = async (
    request: FastifyRequest<{ Params: WorkflowParams; Body: WorkflowResumeRequest }>,
    reply: FastifyReply
  ): Promise<WorkflowStart | FastifyReply> => {
    const { name } = request.params;
    const workflow = findWorkflow(name);
    if (!workflow) return sendError(reply, 404, `Workflow '${name}' not found`, 'NOT_FOUND');

    const { checkpointId, options = {} } = request.body;
    const userId = request.cogitatorAuth?.userId;
    try {
      const checkpoint = await findOwnedCheckpoint(store, userId, workflow.name, checkpointId);
      if (!store || !checkpoint) return sendFailure(reply, checkpointNotFound(checkpointId));
      const checkpoints = ownedCheckpoints(store, userId);
      return async (runOptions) =>
        withResumedCheckpoint(
          await (
            await executorFor(checkpoints)
          ).resume(workflow, checkpointId, {
            ...requestedOptions(options, limits),
            checkpoint: true,
            ...runOptions,
          }),
          checkpointId
        );
    } catch (error) {
      return sendRouteError(request, reply, error, 'workflow resume error');
    }
  };

  const respond = async (
    request: FastifyRequest,
    reply: FastifyReply,
    start: WorkflowStart,
    label: string
  ) => {
    const abortController = new AbortController();
    onClientDisconnect(reply, () => abortController.abort());

    try {
      const result = await start({ signal: abortController.signal });

      if (result.error) {
        return sendFailure(
          reply,
          workflowRunFailure(resolveError(request, result.error, label), result.checkpointId)
        );
      }

      return toWorkflowRunResponse(result);
    } catch (error) {
      if (isModuleNotFound(error)) {
        return sendError(reply, 501, WORKFLOWS_MISSING, 'UNIMPLEMENTED');
      }
      return sendRouteError(request, reply, error, label);
    }
  };

  const stream = async (request: FastifyRequest, reply: FastifyReply, start: WorkflowStart) => {
    const writer = new FastifyStreamWriter(reply, {
      heartbeatMs: fastify.cogitator.sseHeartbeatMs,
    });
    const messageId = generateId('wf');
    const abortController = new AbortController();

    onClientDisconnect(reply, () => {
      abortController.abort();
      writer.close();
    });

    try {
      writer.start(messageId);

      const result = await start({
        signal: abortController.signal,
        onNodeStart: (node: string) => {
          writer.workflowEvent('node_started', { nodeName: node, timestamp: Date.now() });
        },
        onNodeComplete: (node: string, output: unknown, duration: number) => {
          writer.workflowEvent('node_completed', { nodeName: node, output, duration });
        },
        onNodeError: (node: string, error: Error) => {
          writer.workflowEvent('node_error', {
            nodeName: node,
            error: resolveError(request, error, `workflow node ${node} error`).message,
          });
        },
        onNodeProgress: (node: string, progress: number) => {
          writer.workflowEvent('node_progress', { nodeName: node, progress });
        },
      });

      if (result.error) {
        writer.workflowEvent('workflow_failed', toWorkflowFailedData(result));
        const failure = resolveError(request, result.error, 'workflow stream error');
        writer.error(failure.message, failure.code);
      } else {
        writer.workflowEvent('workflow_completed', toWorkflowCompletedData(result));
        writer.finish(messageId);
      }
    } catch (error) {
      if (isModuleNotFound(error)) {
        writer.error(WORKFLOWS_MISSING, 'UNIMPLEMENTED');
      } else if (!abortController.signal.aborted) {
        const resolved = resolveError(request, error, 'workflow stream error');
        writer.error(resolved.message, resolved.code);
      }
    } finally {
      writer.close();
    }

    return reply;
  };

  fastify.get('/workflows', async () => {
    const workflowList = Object.entries(fastify.cogitator.workflows).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: Array.from(workflow.nodes.keys()),
    }));

    const response: WorkflowListResponse = { workflows: workflowList };
    return response;
  });

  fastify.post<{ Params: WorkflowParams; Body: WorkflowRunRequest }>(
    '/workflows/:name/run',
    { schema: runSchema, preValidation: runBody },
    async (request, reply) => {
      const start = startRun(request, reply);
      return typeof start === 'function'
        ? respond(request, reply, start, 'workflow run error')
        : start;
    }
  );

  fastify.post<{ Params: WorkflowParams; Body: WorkflowRunRequest }>(
    '/workflows/:name/stream',
    { schema: runSchema, preValidation: runBody },
    async (request, reply) => {
      const start = startRun(request, reply);
      return typeof start === 'function' ? stream(request, reply, start) : start;
    }
  );

  fastify.post<{ Params: WorkflowParams; Body: WorkflowResumeRequest }>(
    '/workflows/:name/resume',
    { schema: resumeSchema, preValidation: resumeBody },
    async (request, reply) => {
      const start = await startResume(request, reply);
      return typeof start === 'function'
        ? respond(request, reply, start, 'workflow resume error')
        : start;
    }
  );

  fastify.post<{ Params: WorkflowParams; Body: WorkflowResumeRequest }>(
    '/workflows/:name/resume/stream',
    { schema: resumeSchema, preValidation: resumeBody },
    async (request, reply) => {
      const start = await startResume(request, reply);
      return typeof start === 'function' ? stream(request, reply, start) : start;
    }
  );
};
