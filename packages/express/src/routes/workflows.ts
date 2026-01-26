import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  WorkflowListResponse,
  WorkflowRunRequest,
  WorkflowRunResponse,
} from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';

export function createWorkflowRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/workflows', (_req, res) => {
    const workflowList = Object.entries(ctx.workflows).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: Array.from(workflow.nodes.keys()),
    }));

    const response: WorkflowListResponse = { workflows: workflowList };
    res.json(response);
  });

  router.post('/workflows/:name/run', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const workflow = ctx.workflows[name];

    if (!workflow) {
      res.status(404).json({
        error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    const body = req.body as WorkflowRunRequest;

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.cogitator);

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

      res.json(response);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cannot find module')) {
        res.status(501).json({
          error: { message: 'Workflows package not installed', code: 'UNIMPLEMENTED' },
        });
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: { message, code: 'INTERNAL' },
      });
    }
  });

  router.post('/workflows/:name/stream', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const workflow = ctx.workflows[name];

    if (!workflow) {
      res.status(404).json({
        error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    const body = req.body as WorkflowRunRequest;

    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res);
    const messageId = generateId('wf');

    req.on('close', () => {
      writer.close();
    });

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.cogitator);

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
