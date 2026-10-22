import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type {
  CheckpointStore,
  WorkflowExecuteOptions,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
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
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, WorkflowListResponse } from '../types.js';
import { getOwn } from '../utils/lookup.js';
import { describeError, isModuleNotFoundError } from '../utils/errors.js';
import {
  createRequestAbortController,
  holdConnectionOpen,
  errorResponse,
  invalidInput,
  bodyRefused,
  notFound,
  notInstalled,
  readJsonBody,
  requestAborted,
  sendError,
} from '../utils/request.js';
import { toWorkflowRunResponse } from '../utils/results.js';

type WorkflowRunOptions = WorkflowExecuteOptions & { signal: AbortSignal };

/** Runs or resumes a workflow with the options of a request and the callbacks of its answer */
type WorkflowStart = (options: WorkflowRunOptions) => Promise<WorkflowResult<WorkflowState>>;

async function executorFor(c: Context<HonoEnv>, checkpoints: CheckpointStore | undefined) {
  const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
  return new WorkflowExecutor(c.get('cogitator').runtime, checkpoints);
}

/** The start of a workflow run, or the answer that refused it */
async function admitRun(c: Context<HonoEnv>): Promise<WorkflowStart | Response> {
  const ctx = c.get('cogitator');
  const name = c.req.param('name') ?? '';
  const workflow = getOwn(ctx.workflows, name);
  if (!workflow) return notFound(c, `Workflow '${name}' not found`);

  const body = await readJsonBody(c);
  if (!body.ok) return bodyRefused(c, body.refusal);
  const store = ctx.workflowCheckpoints;
  const parsed = parseWorkflowRunRequest(body.value, { checkpoints: store !== undefined });
  if (!parsed.ok) return invalidInput(c, parsed.message);

  const { input, options = {} } = parsed.value;
  const checkpoints =
    options.checkpoint && store
      ? ownedCheckpoints(store, c.get('cogitatorAuth')?.userId)
      : undefined;
  return async (runOptions) =>
    (await executorFor(c, checkpoints)).execute(workflow, input, {
      ...workflowOptionsWithin(options, ctx.limits),
      ...runOptions,
    });
}

/**
 * The start of a workflow resume, or the answer that refused it: a checkpoint that is missing,
 * belongs to another user or to another workflow is refused before anything runs
 */
async function admitResume(c: Context<HonoEnv>): Promise<WorkflowStart | Response> {
  const ctx = c.get('cogitator');
  const name = c.req.param('name') ?? '';
  const workflow = getOwn(ctx.workflows, name);
  if (!workflow) return notFound(c, `Workflow '${name}' not found`);

  const body = await readJsonBody(c);
  if (!body.ok) return bodyRefused(c, body.refusal);
  const parsed = parseWorkflowResumeRequest(body.value);
  if (!parsed.ok) return invalidInput(c, parsed.message);

  const { checkpointId, options = {} } = parsed.value;
  const store = ctx.workflowCheckpoints;
  const userId = c.get('cogitatorAuth')?.userId;
  try {
    const checkpoint = await findOwnedCheckpoint(store, userId, workflow.name, checkpointId);
    if (!store || !checkpoint) return sendError(c, checkpointNotFound(checkpointId));
    const checkpoints = ownedCheckpoints(store, userId);
    return async (runOptions) =>
      withResumedCheckpoint(
        await (
          await executorFor(c, checkpoints)
        ).resume(workflow, checkpointId, {
          ...workflowOptionsWithin(options, ctx.limits),
          checkpoint: true,
          ...runOptions,
        }),
        checkpointId
      );
  } catch (error) {
    return errorResponse(c, error, 'Workflow resume error');
  }
}

async function respond(c: Context<HonoEnv>, start: WorkflowStart, label: string) {
  holdConnectionOpen(c);
  const abortController = createRequestAbortController(c);

  try {
    const result = await start({ signal: abortController.signal });

    if (abortController.signal.aborted) return requestAborted(c);
    if (result.error) {
      return sendError(
        c,
        workflowRunFailure(describeError(result.error, label), result.checkpointId)
      );
    }

    return c.json(toWorkflowRunResponse(result));
  } catch (error) {
    if (abortController.signal.aborted) return requestAborted(c);
    if (isModuleNotFoundError(error)) {
      return notInstalled(c, 'Workflows');
    }
    return errorResponse(c, error, label);
  }
}

function stream(c: Context<HonoEnv>, start: WorkflowStart) {
  const abortController = createRequestAbortController(c);

  return streamSSE(c, async (sse) => {
    const writer = new HonoStreamWriter(sse, { heartbeatMs: c.get('cogitator').sseHeartbeatMs });
    const messageId = generateId('wf');

    sse.onAbort(() => {
      writer.close();
      abortController.abort();
    });

    try {
      await writer.start(messageId);

      const result = await start({
        signal: abortController.signal,
        onNodeStart: (node: string) => {
          void writer.workflowEvent('node_started', { nodeName: node, timestamp: Date.now() });
        },
        onNodeComplete: (node: string, output: unknown, duration: number) => {
          void writer.workflowEvent('node_completed', { nodeName: node, output, duration });
        },
        onNodeError: (node: string, error: Error) => {
          void writer.workflowEvent('node_error', {
            nodeName: node,
            error: describeError(error, `Workflow node ${node} error`).message,
          });
        },
        onNodeProgress: (node: string, progress: number) => {
          void writer.workflowEvent('node_progress', { nodeName: node, progress });
        },
      });

      if (abortController.signal.aborted) return;

      if (result.error) {
        await writer.workflowEvent('workflow_failed', toWorkflowFailedData(result));
        const failure = describeError(result.error, 'Workflow stream error');
        await writer.error(failure.message, failure.code);
        return;
      }

      await writer.workflowEvent('workflow_completed', toWorkflowCompletedData(result));
      await writer.finish(messageId);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isModuleNotFoundError(error)) {
        await writer.error('Workflows package not installed', 'UNIMPLEMENTED');
      } else {
        const failure = describeError(error, 'Workflow stream error');
        await writer.error(failure.message, failure.code);
      }
    } finally {
      writer.close();
    }
  });
}

export function createWorkflowRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/workflows', (c) => {
    const ctx = c.get('cogitator');
    const workflowList = Object.entries(ctx.workflows).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: Array.from(workflow.nodes.keys()),
    }));

    const response: WorkflowListResponse = { workflows: workflowList };
    return c.json(response);
  });

  app.post('/workflows/:name/run', async (c) => {
    const start = await admitRun(c);
    return start instanceof Response ? start : respond(c, start, 'Workflow run error');
  });

  app.post('/workflows/:name/stream', async (c) => {
    const start = await admitRun(c);
    return start instanceof Response ? start : stream(c, start);
  });

  app.post('/workflows/:name/resume', async (c) => {
    const start = await admitResume(c);
    return start instanceof Response ? start : respond(c, start, 'Workflow resume error');
  });

  app.post('/workflows/:name/resume/stream', async (c) => {
    const start = await admitResume(c);
    return start instanceof Response ? start : stream(c, start);
  });

  return app;
}
