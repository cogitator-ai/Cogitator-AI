import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  WorkflowListResponse,
  WorkflowRunResponse,
} from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import {
  handleRouteError,
  isModuleNotFound,
  onClientDisconnect,
  parseWorkflowBody,
  resolveError,
  sendError,
} from './utils.js';

const WORKFLOWS_MISSING = 'Workflows package not installed';

export function createWorkflowRoutes(ctx: RouteContext): Router {
  const router = Router();

  const findWorkflow = (name: string) =>
    Object.hasOwn(ctx.workflows, name) ? ctx.workflows[name] : undefined;

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
    const workflow = findWorkflow(name);

    if (!workflow) {
      sendError(res, 404, `Workflow '${name}' not found`, 'NOT_FOUND');
      return;
    }

    const parsed = parseWorkflowBody(req.body);
    if (!parsed.ok) {
      sendError(res, 400, parsed.message, 'INVALID_INPUT');
      return;
    }
    const body = parsed.value;

    const abortController = new AbortController();
    onClientDisconnect(res, () => abortController.abort());

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.cogitator);

      const result = await executor.execute(workflow, body.input, {
        ...body.options,
        signal: abortController.signal,
      });

      if (abortController.signal.aborted) return;

      if (result.error) {
        sendError(res, 500, `Workflow failed: ${result.error.message}`, 'WORKFLOW_FAILED');
        return;
      }

      const response: WorkflowRunResponse = {
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        state: result.state,
        duration: result.duration,
        nodeResults: Object.fromEntries(result.nodeResults),
      };

      res.json(response);
    } catch (error) {
      if (isModuleNotFound(error)) {
        sendError(res, 501, WORKFLOWS_MISSING, 'UNIMPLEMENTED');
        return;
      }
      handleRouteError(res, error, 'Workflow run error');
    }
  });

  router.post('/workflows/:name/stream', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const workflow = findWorkflow(name);

    if (!workflow) {
      sendError(res, 404, `Workflow '${name}' not found`, 'NOT_FOUND');
      return;
    }

    const parsed = parseWorkflowBody(req.body);
    if (!parsed.ok) {
      sendError(res, 400, parsed.message, 'INVALID_INPUT');
      return;
    }
    const body = parsed.value;

    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res);
    const messageId = generateId('wf');
    const abortController = new AbortController();

    onClientDisconnect(res, () => {
      abortController.abort();
      writer.close();
    });

    try {
      const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
      const executor = new WorkflowExecutor(ctx.cogitator);

      writer.start(messageId);

      const result = await executor.execute(workflow, body.input, {
        ...body.options,
        signal: abortController.signal,
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

      if (result.error) {
        writer.error(`Workflow failed: ${result.error.message}`, 'WORKFLOW_FAILED');
        return;
      }

      writer.workflowEvent('workflow_completed', {
        workflowId: result.workflowId,
        duration: result.duration,
      });

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
  });

  return router;
}
