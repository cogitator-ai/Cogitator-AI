import Router from '@koa/router';
import type {
  CogitatorState,
  WorkflowListResponse,
  WorkflowRunRequest,
  WorkflowRunResponse,
} from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { generateId } from '@cogitator-ai/server-shared';

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
    const workflow = workflows[name];

    if (!workflow) {
      ctx.status = 404;
      ctx.body = { error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const body = (ctx.request as unknown as { body: WorkflowRunRequest }).body;

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(runtime);

      const result = await executor.execute(workflow, body?.input, body?.options);

      const nodeResults: Record<string, { output: unknown; duration: number }> = {};
      for (const [nodeName, nodeResult] of result.nodeResults.entries()) {
        nodeResults[nodeName] = nodeResult;
      }

      const response: WorkflowRunResponse = {
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        state: result.state,
        duration: result.duration,
        nodeResults,
      };

      ctx.body = response;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        ctx.status = 501;
        ctx.body = { error: { message: 'Workflows package not installed', code: 'UNIMPLEMENTED' } };
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      ctx.status = 500;
      ctx.body = { error: { message, code: 'INTERNAL' } };
    }
  });

  router.post('/workflows/:name/stream', async (ctx) => {
    const { workflows, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const workflow = workflows[name];

    if (!workflow) {
      ctx.status = 404;
      ctx.body = { error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const body = (ctx.request as unknown as { body: WorkflowRunRequest }).body;

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx);
    const messageId = generateId('wf');

    ctx.req.on('close', () => {
      writer.close();
    });

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(runtime);

      writer.start(messageId);

      const result = await executor.execute(workflow, body?.input, {
        ...body?.options,
        onNodeStart: (node: string) => {
          writer.workflowEvent('node_started', { nodeName: node, timestamp: Date.now() });
        },
        onNodeComplete: (node: string, output: unknown, duration: number) => {
          writer.workflowEvent('node_completed', { nodeName: node, output, duration });
        },
        onNodeError: (node: string, error: Error) => {
          writer.workflowEvent('node_error', { nodeName: node, error: error.message });
        },
        onNodeProgress: (node: string, progress: number) => {
          writer.workflowEvent('node_progress', { nodeName: node, progress });
        },
      });

      writer.workflowEvent('workflow_completed', {
        workflowId: result.workflowId,
        duration: result.duration,
      });

      writer.finish(messageId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        writer.error('Workflows package not installed', 'UNIMPLEMENTED');
      } else {
        const message = error instanceof Error ? error.message : 'Unknown error';
        writer.error(message, 'INTERNAL');
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
