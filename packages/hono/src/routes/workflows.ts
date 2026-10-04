import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, WorkflowListResponse } from '../types.js';
import { getOwn } from '../utils/lookup.js';
import { isModuleNotFoundError, resolveError } from '../utils/errors.js';
import {
  createRequestAbortController,
  holdConnectionOpen,
  errorResponse,
  invalidInput,
  invalidJson,
  readJsonBody,
  requestAborted,
} from '../utils/request.js';
import { toWorkflowRunResponse } from '../utils/results.js';
import { parseWorkflowRunRequest } from '../utils/validation.js';

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
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const workflow = getOwn(ctx.workflows, name);

    if (!workflow) {
      return c.json({ error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseWorkflowRunRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    holdConnectionOpen(c);
    const abortController = createRequestAbortController(c);

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.runtime);
      const result = await executor.execute(workflow, parsed.value.input, {
        ...parsed.value.options,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) return requestAborted(c);
      if (result.error) return errorResponse(c, result.error, 'Workflow run error');

      return c.json(toWorkflowRunResponse(result));
    } catch (error) {
      if (abortController.signal.aborted) return requestAborted(c);
      if (isModuleNotFoundError(error)) {
        return c.json(
          { error: { message: 'Workflows package not installed', code: 'UNIMPLEMENTED' } },
          501
        );
      }
      return errorResponse(c, error, 'Workflow run error');
    }
  });

  app.post('/workflows/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const workflow = getOwn(ctx.workflows, name);

    if (!workflow) {
      return c.json({ error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseWorkflowRunRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const abortController = createRequestAbortController(c);

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream, { heartbeatMs: ctx.sseHeartbeatMs });
      const messageId = generateId('wf');

      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });

      try {
        const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
        const executor = new WorkflowExecutor(ctx.runtime);

        await writer.start(messageId);

        const result = await executor.execute(workflow, parsed.value.input, {
          ...parsed.value.options,
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
              error: resolveError(error, `Workflow node ${node} error`).body.error.message,
            });
          },
          onNodeProgress: (node: string, progress: number) => {
            void writer.workflowEvent('node_progress', { nodeName: node, progress });
          },
        });

        if (abortController.signal.aborted) return;

        if (result.error) {
          const { body: errorBody } = resolveError(result.error, 'Workflow stream error');
          await writer.error(errorBody.error.message, errorBody.error.code);
          return;
        }

        await writer.workflowEvent('workflow_completed', {
          workflowId: result.workflowId,
          duration: result.duration,
        });
        await writer.finish(messageId);
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isModuleNotFoundError(error)) {
          await writer.error('Workflows package not installed', 'UNIMPLEMENTED');
        } else {
          const { body: errorBody } = resolveError(error, 'Workflow stream error');
          await writer.error(errorBody.error.message, errorBody.error.code);
        }
      } finally {
        writer.close();
      }
    });
  });

  return app;
}
