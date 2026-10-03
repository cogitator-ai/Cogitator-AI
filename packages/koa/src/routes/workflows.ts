import Router from '@koa/router';
import type { CogitatorState, WorkflowListResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { generateId } from '@cogitator-ai/server-shared';
import { getOwn } from '../utils/lookup.js';
import { isModuleNotFoundError, resolveError } from '../utils/errors.js';
import { getRequestBody, onClientDisconnect } from '../utils/request.js';
import { toWorkflowRunResponse } from '../utils/results.js';
import { parseWorkflowRunRequest } from '../utils/validation.js';

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
    const { workflows, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const workflow = getOwn(workflows, name);

    if (!workflow) {
      ctx.status = 404;
      ctx.body = { error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseWorkflowRunRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    const abortController = new AbortController();
    onClientDisconnect(ctx, () => abortController.abort());

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(runtime);

      const result = await executor.execute(workflow, parsed.value.input, {
        ...parsed.value.options,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) return;

      if (result.error) {
        const { status, body } = resolveError(result.error, 'Workflow run error');
        ctx.status = status;
        ctx.body = body;
        return;
      }

      ctx.body = toWorkflowRunResponse(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isModuleNotFoundError(error)) {
        ctx.status = 501;
        ctx.body = { error: { message: 'Workflows package not installed', code: 'UNIMPLEMENTED' } };
        return;
      }

      const { status, body } = resolveError(error, 'Workflow run error');
      ctx.status = status;
      ctx.body = body;
    }
  });

  router.post('/workflows/:name/stream', async (ctx) => {
    const { workflows, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const workflow = getOwn(workflows, name);

    if (!workflow) {
      ctx.status = 404;
      ctx.body = { error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseWorkflowRunRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx);
    const messageId = generateId('wf');
    const abortController = new AbortController();

    onClientDisconnect(ctx, () => {
      writer.close();
      abortController.abort();
    });

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(runtime);

      writer.start(messageId);

      const result = await executor.execute(workflow, parsed.value.input, {
        ...parsed.value.options,
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
            error: resolveError(error, `Workflow node ${node} error`).body.error.message,
          });
        },
        onNodeProgress: (node: string, progress: number) => {
          writer.workflowEvent('node_progress', { nodeName: node, progress });
        },
      });

      if (abortController.signal.aborted) return;

      if (result.error) {
        const { body } = resolveError(result.error, 'Workflow stream error');
        writer.error(body.error.message, body.error.code);
        return;
      }

      writer.workflowEvent('workflow_completed', {
        workflowId: result.workflowId,
        duration: result.duration,
      });
      writer.finish(messageId);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isModuleNotFoundError(error)) {
        writer.error('Workflows package not installed', 'UNIMPLEMENTED');
      } else {
        const { body } = resolveError(error, 'Workflow stream error');
        writer.error(body.error.message, body.error.code);
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
