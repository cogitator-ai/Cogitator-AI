import Router from '@koa/router';
import type { CogitatorState, WorkflowListResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import {
  generateId,
  parseWorkflowRunRequest,
  workflowOptionsWithin,
} from '@cogitator-ai/server-shared';
import { getOwn } from '../utils/lookup.js';
import {
  describeError,
  invalidInput,
  isModuleNotFoundError,
  notFound,
  notInstalled,
  respondWithError,
} from '../utils/errors.js';
import { getRequestBody, onClientDisconnect } from '../utils/request.js';
import { toWorkflowRunResponse } from '../utils/results.js';

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
      notFound(ctx, `Workflow '${name}' not found`);
      return;
    }

    const parsed = parseWorkflowRunRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }

    const abortController = new AbortController();
    onClientDisconnect(ctx, () => abortController.abort());

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(runtime);

      const result = await executor.execute(workflow, parsed.value.input, {
        ...workflowOptionsWithin(parsed.value.options ?? {}, ctx.state.cogitator.limits),
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) return;

      if (result.error) {
        respondWithError(ctx, result.error, 'Workflow run error');
        return;
      }

      ctx.body = toWorkflowRunResponse(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isModuleNotFoundError(error)) {
        notInstalled(ctx, 'Workflows');
        return;
      }

      respondWithError(ctx, error, 'Workflow run error');
    }
  });

  router.post('/workflows/:name/stream', async (ctx) => {
    const { workflows, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const workflow = getOwn(workflows, name);

    if (!workflow) {
      notFound(ctx, `Workflow '${name}' not found`);
      return;
    }

    const parsed = parseWorkflowRunRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }

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
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(runtime);

      writer.start(messageId);

      const result = await executor.execute(workflow, parsed.value.input, {
        ...workflowOptionsWithin(parsed.value.options ?? {}, ctx.state.cogitator.limits),
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
        const failure = describeError(result.error, 'Workflow stream error');
        writer.error(failure.message, failure.code);
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
        const failure = describeError(error, 'Workflow stream error');
        writer.error(failure.message, failure.code);
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
