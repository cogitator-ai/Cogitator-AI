import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type {
  HonoEnv,
  WorkflowListResponse,
  WorkflowRunRequest,
  WorkflowRunResponse,
} from '../types.js';
import { CogitatorError } from '@cogitator-ai/types';

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
    const workflow = Object.hasOwn(ctx.workflows, name) ? ctx.workflows[name] : undefined;

    if (!workflow) {
      return c.json({ error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    let body: WorkflowRunRequest | undefined;
    try {
      body = await c.req.json<WorkflowRunRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.runtime);
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

      return c.json(response);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
        return c.json(
          { error: { message: 'Workflows package not installed', code: 'UNIMPLEMENTED' } },
          501
        );
      }

      if (CogitatorError.isCogitatorError(error)) {
        return c.json({ error: { message: error.message, code: error.code } }, 500);
      }
      console.error('[CogitatorHono] Workflow run error:', error);
      return c.json({ error: { message: 'Internal server error', code: 'INTERNAL' } }, 500);
    }
  });

  app.post('/workflows/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const workflow = Object.hasOwn(ctx.workflows, name) ? ctx.workflows[name] : undefined;

    if (!workflow) {
      return c.json({ error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    let body: WorkflowRunRequest | undefined;
    try {
      body = await c.req.json<WorkflowRunRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream);
      const messageId = generateId('wf');

      stream.onAbort(() => writer.close());

      try {
        const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
        const executor = new WorkflowExecutor(ctx.runtime);

        await writer.start(messageId);

        const result = await executor.execute(workflow, body?.input, {
          ...body?.options,
          onNodeStart: (node: string) => {
            void writer.workflowEvent('node_started', { nodeName: node, timestamp: Date.now() });
          },
          onNodeComplete: (node: string, output: unknown, duration: number) => {
            void writer.workflowEvent('node_completed', { nodeName: node, output, duration });
          },
          onNodeError: (node: string, error: Error) => {
            void writer.workflowEvent('node_error', { nodeName: node, error: error.message });
          },
          onNodeProgress: (node: string, progress: number) => {
            void writer.workflowEvent('node_progress', { nodeName: node, progress });
          },
        });

        await writer.workflowEvent('workflow_completed', {
          workflowId: result.workflowId,
          duration: result.duration,
        });

        await writer.finish(messageId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
          await writer.error('Workflows package not installed', 'UNIMPLEMENTED');
        } else if (CogitatorError.isCogitatorError(error)) {
          await writer.error(error.message, error.code);
        } else {
          console.error('[CogitatorHono] Workflow stream error:', error);
          await writer.error('Internal server error', 'INTERNAL');
        }
      } finally {
        writer.close();
      }
    });
  });

  return app;
}
