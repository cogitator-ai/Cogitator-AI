import { Router } from 'express';
import type { Response } from 'express';
import type {
  CheckpointStore,
  Workflow,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type {
  RouteContext,
  CogitatorRequest,
  WorkflowListResponse,
  WorkflowRunResponse,
} from '../types.js';
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
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import {
  handleRouteError,
  isModuleNotFound,
  onClientDisconnect,
  resolveError,
  sendError,
  sendFailure,
} from './utils.js';

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

export function createWorkflowRoutes(ctx: RouteContext): Router {
  const router = Router();
  const store = ctx.config.workflowCheckpoints;

  const findWorkflow = (name: string) =>
    Object.hasOwn(ctx.workflows, name) ? ctx.workflows[name] : undefined;

  const executorFor = async (checkpoints: CheckpointStore | undefined) => {
    const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
    return new WorkflowExecutor(ctx.cogitator, checkpoints);
  };

  const workflowOf = (
    req: CogitatorRequest<{ name: string }>,
    res: Response
  ): Workflow<WorkflowState> | undefined => {
    const { name } = req.params;
    const workflow = findWorkflow(name);
    if (!workflow) sendError(res, 404, `Workflow '${name}' not found`, 'NOT_FOUND');
    return workflow;
  };

  const admitRun = (
    req: CogitatorRequest<{ name: string }>,
    res: Response
  ): WorkflowStart | undefined => {
    const workflow = workflowOf(req, res);
    if (!workflow) return undefined;

    const parsed = parseWorkflowRunRequest(req.body, { checkpoints: store !== undefined });
    if (!parsed.ok) {
      sendError(res, 400, parsed.message, 'INVALID_INPUT');
      return undefined;
    }
    const { input, options = {} } = parsed.value;
    const checkpoints =
      options.checkpoint && store
        ? ownedCheckpoints(store, req.cogitator?.auth?.userId)
        : undefined;

    return async (runOptions) =>
      (await executorFor(checkpoints)).execute(workflow, input, {
        ...workflowOptionsWithin(options, ctx.config.limits),
        ...runOptions,
      });
  };

  const admitResume = async (
    req: CogitatorRequest<{ name: string }>,
    res: Response
  ): Promise<WorkflowStart | undefined> => {
    const workflow = workflowOf(req, res);
    if (!workflow) return undefined;

    const parsed = parseWorkflowResumeRequest(req.body);
    if (!parsed.ok) {
      sendError(res, 400, parsed.message, 'INVALID_INPUT');
      return undefined;
    }
    const { checkpointId, options = {} } = parsed.value;
    const userId = req.cogitator?.auth?.userId;

    try {
      const checkpoint = await findOwnedCheckpoint(store, userId, workflow.name, checkpointId);
      if (!store || !checkpoint) {
        sendFailure(res, checkpointNotFound(checkpointId));
        return undefined;
      }
      const checkpoints = ownedCheckpoints(store, userId);
      return async (runOptions) =>
        withResumedCheckpoint(
          await (
            await executorFor(checkpoints)
          ).resume(workflow, checkpointId, {
            ...workflowOptionsWithin(options, ctx.config.limits),
            checkpoint: true,
            ...runOptions,
          }),
          checkpointId
        );
    } catch (error) {
      handleRouteError(res, error, 'Workflow resume error');
      return undefined;
    }
  };

  const respond = async (res: Response, start: WorkflowStart, label: string) => {
    const abortController = new AbortController();
    onClientDisconnect(res, () => abortController.abort());

    try {
      const result = await start({ signal: abortController.signal });

      if (abortController.signal.aborted) return;

      if (result.error) {
        if (!res.headersSent) {
          sendFailure(
            res,
            workflowRunFailure(resolveError(result.error, label), result.checkpointId)
          );
        }
        return;
      }

      res.json(toWorkflowRunResponse(result));
    } catch (error) {
      if (isModuleNotFound(error)) {
        sendError(res, 501, WORKFLOWS_MISSING, 'UNIMPLEMENTED');
        return;
      }
      handleRouteError(res, error, label);
    }
  };

  const stream = async (res: Response, start: WorkflowStart) => {
    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res, { heartbeatMs: ctx.config.sseHeartbeatMs });
    const messageId = generateId('wf');
    const abortController = new AbortController();

    onClientDisconnect(res, () => {
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
            error: resolveError(error, `Workflow node ${node}`).message,
          });
        },
        onNodeProgress: (node: string, progress: number) => {
          writer.workflowEvent('node_progress', { nodeName: node, progress });
        },
      });

      if (result.error) {
        writer.workflowEvent('workflow_failed', toWorkflowFailedData(result));
        const failure = resolveError(result.error, 'Workflow stream error');
        writer.error(failure.message, failure.code);
        return;
      }

      writer.workflowEvent('workflow_completed', toWorkflowCompletedData(result));

      writer.finish(messageId);
    } catch (error) {
      if (isModuleNotFound(error)) {
        writer.error(WORKFLOWS_MISSING, 'UNIMPLEMENTED');
      } else if (!abortController.signal.aborted) {
        const resolved = resolveError(error, 'Workflow stream error');
        writer.error(resolved.message, resolved.code);
      }
    } finally {
      writer.close();
    }
  };

  router.get('/workflows', (_req, res) => {
    const workflowList = Object.entries(ctx.workflows).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: Array.from(workflow.nodes.keys()),
    }));

    const response: WorkflowListResponse = { workflows: workflowList };
    res.json(response);
  });

  router.post(
    '/workflows/:name/run',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const start = admitRun(req, res);
      if (start) await respond(res, start, 'Workflow run error');
    }
  );

  router.post(
    '/workflows/:name/stream',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const start = admitRun(req, res);
      if (start) await stream(res, start);
    }
  );

  router.post(
    '/workflows/:name/resume',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const start = await admitResume(req, res);
      if (start) await respond(res, start, 'Workflow resume error');
    }
  );

  router.post(
    '/workflows/:name/resume/stream',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const start = await admitResume(req, res);
      if (start) await stream(res, start);
    }
  );

  return router;
}
