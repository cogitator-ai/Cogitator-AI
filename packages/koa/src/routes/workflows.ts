import Router from '@koa/router';
import type { ParameterizedContext } from 'koa';
import type {
  CheckpointStore,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type { CogitatorState, WorkflowListResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import {
  checkpointNotFound,
  findOwnedCheckpoint,
  generateId,
  ownedCheckpoints,
  parseWorkflowResumeRequest,
  parseWorkflowRunRequest,
  toWorkflowCompletedData,
  toWorkflowFailedData,
  withResumedCheckpoint,
  workflowOptionsWithin,
  workflowRunFailure,
} from '@cogitator-ai/server-shared';
import { getOwn } from '../utils/lookup.js';
import {
  describeError,
  invalidInput,
  isModuleNotFoundError,
  notFound,
  notInstalled,
  respondWithError,
  sendError,
} from '../utils/errors.js';
import { getRequestBody, onClientDisconnect } from '../utils/request.js';
import { toWorkflowRunResponse } from '../utils/results.js';

type WorkflowContext = ParameterizedContext<CogitatorState> & { params: Record<string, string> };

type WorkflowRunOptions = WorkflowExecuteOptions & { signal: AbortSignal };

/** Runs or resumes a workflow with the options of a request and the callbacks of its answer */
type WorkflowStart = (options: WorkflowRunOptions) => Promise<WorkflowResult<WorkflowState>>;

async function executorFor(ctx: WorkflowContext, checkpoints: CheckpointStore | undefined) {
  const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
  return new WorkflowExecutor(ctx.state.cogitator.runtime, checkpoints);
}

function findWorkflow(ctx: WorkflowContext) {
  const { name } = ctx.params;
  const workflow = getOwn(ctx.state.cogitator.workflows, name);
  if (!workflow) notFound(ctx, `Workflow '${name}' not found`);
  return workflow;
}

/** The start of a workflow run, `undefined` once the request was refused */
function admitRun(ctx: WorkflowContext): WorkflowStart | undefined {
  const workflow = findWorkflow(ctx);
  if (!workflow) return undefined;

  const { limits, workflowCheckpoints: store } = ctx.state.cogitator;
  const parsed = parseWorkflowRunRequest(getRequestBody(ctx), {
    checkpoints: store !== undefined,
  });
  if (!parsed.ok) {
    invalidInput(ctx, parsed.message);
    return undefined;
  }

  const { input, options = {} } = parsed.value;
  const checkpoints =
    options.checkpoint && store ? ownedCheckpoints(store, ctx.state.auth?.userId) : undefined;
  return async (runOptions) =>
    (await executorFor(ctx, checkpoints)).execute(workflow, input, {
      ...workflowOptionsWithin(options, limits),
      ...runOptions,
    });
}

/**
 * The start of a workflow resume, `undefined` once the request was refused: a checkpoint that
 * is missing, belongs to another user or to another workflow is refused before anything runs
 */
async function admitResume(ctx: WorkflowContext): Promise<WorkflowStart | undefined> {
  const workflow = findWorkflow(ctx);
  if (!workflow) return undefined;

  const parsed = parseWorkflowResumeRequest(getRequestBody(ctx));
  if (!parsed.ok) {
    invalidInput(ctx, parsed.message);
    return undefined;
  }

  const { checkpointId, options = {} } = parsed.value;
  const { limits, workflowCheckpoints: store } = ctx.state.cogitator;
  const userId = ctx.state.auth?.userId;
  try {
    const checkpoint = await findOwnedCheckpoint(store, userId, workflow.name, checkpointId);
    if (!store || !checkpoint) {
      sendError(ctx, checkpointNotFound(checkpointId));
      return undefined;
    }
    const checkpoints = ownedCheckpoints(store, userId);
    return async (runOptions) =>
      withResumedCheckpoint(
        await (
          await executorFor(ctx, checkpoints)
        ).resume(workflow, checkpointId, {
          ...workflowOptionsWithin(options, limits),
          checkpoint: true,
          ...runOptions,
        }),
        checkpointId
      );
  } catch (error) {
    respondWithError(ctx, error, 'Workflow resume error');
    return undefined;
  }
}

async function respond(ctx: WorkflowContext, start: WorkflowStart, label: string) {
  const abortController = new AbortController();
  onClientDisconnect(ctx, () => abortController.abort());

  try {
    const result = await start({ signal: abortController.signal });

    if (abortController.signal.aborted) return;

    if (result.error) {
      sendError(ctx, workflowRunFailure(describeError(result.error, label), result.checkpointId));
      return;
    }

    ctx.body = toWorkflowRunResponse(result);
  } catch (error) {
    if (abortController.signal.aborted) return;
    if (isModuleNotFoundError(error)) {
      notInstalled(ctx, 'Workflows');
      return;
    }

    respondWithError(ctx, error, label);
  }
}

async function stream(ctx: WorkflowContext, start: WorkflowStart) {
  setupSSEHeaders(ctx);
  const writer = new KoaStreamWriter(ctx, {
    heartbeatMs: ctx.state.cogitator.sseHeartbeatMs,
  });
  const messageId = generateId('wf');
  const abortController = new AbortController();

  onClientDisconnect(ctx, () => {
    writer.close();
    abortController.abort();
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
          error: describeError(error, `Workflow node ${node} error`).message,
        });
      },
      onNodeProgress: (node: string, progress: number) => {
        writer.workflowEvent('node_progress', { nodeName: node, progress });
      },
    });

    if (abortController.signal.aborted) return;

    if (result.error) {
      writer.workflowEvent('workflow_failed', toWorkflowFailedData(result));
      const failure = describeError(result.error, 'Workflow stream error');
      writer.error(failure.message, failure.code);
      return;
    }

    writer.workflowEvent('workflow_completed', toWorkflowCompletedData(result));
    writer.finish(messageId);
  } catch (error) {
    if (abortController.signal.aborted) return;
    if (isModuleNotFoundError(error)) {
      writer.error('Workflows package not installed', 'UNIMPLEMENTED');
    } else {
      const failure = describeError(error, 'Workflow stream error');
      writer.error(failure.message, failure.code);
    }
  } finally {
    writer.close();
  }
}

export function createWorkflowRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/workflows', (ctx) => {
    const { workflows } = ctx.state.cogitator;
    const workflowList = Object.entries(workflows).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: Array.from(workflow.nodes.keys()),
    }));

    const response: WorkflowListResponse = { workflows: workflowList };
    ctx.body = response;
  });

  router.post('/workflows/:name/run', async (ctx) => {
    const start = admitRun(ctx);
    if (start) await respond(ctx, start, 'Workflow run error');
  });

  router.post('/workflows/:name/stream', async (ctx) => {
    const start = admitRun(ctx);
    if (start) await stream(ctx, start);
  });

  router.post('/workflows/:name/resume', async (ctx) => {
    const start = await admitResume(ctx);
    if (start) await respond(ctx, start, 'Workflow resume error');
  });

  router.post('/workflows/:name/resume/stream', async (ctx) => {
    const start = await admitResume(ctx);
    if (start) await stream(ctx, start);
  });

  return router;
}
