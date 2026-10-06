import type { FastifyPluginAsync } from 'fastify';
import type { WorkflowListResponse, WorkflowRunRequest, WorkflowRunResponse } from '../types.js';
import { WorkflowRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import { parseWorkflowRunRequest } from '@cogitator-ai/server-shared';
import {
  isModuleNotFound,
  onClientDisconnect,
  resolveError,
  sendError,
  sendRouteError,
  validateBody,
} from './utils.js';

const workflowBody = validateBody(parseWorkflowRunRequest);

interface WorkflowParams {
  name: string;
}

const paramsSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const;

const WORKFLOWS_MISSING = 'Workflows package not installed';

function executorOptions(body: WorkflowRunRequest | undefined) {
  const options = body?.options ?? {};
  return {
    maxConcurrency: options.maxConcurrency,
    maxIterations: options.maxIterations,
  };
}

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
  const findWorkflow = (name: string) =>
    Object.hasOwn(fastify.cogitator.workflows, name)
      ? fastify.cogitator.workflows[name]
      : undefined;

  fastify.get('/workflows', async () => {
    const workflowList = Object.entries(fastify.cogitator.workflows).map(([name, workflow]) => ({
      name,
      entryPoint: workflow.entryPoint,
      nodes: Array.from(workflow.nodes.keys()),
    }));

    const response: WorkflowListResponse = { workflows: workflowList };
    return response;
  });

  fastify.post<{ Params: WorkflowParams; Body: WorkflowRunRequest }>(
    '/workflows/:name/run',
    {
      schema: { params: paramsSchema, body: WorkflowRunRequestSchema },
      preValidation: workflowBody,
    },
    async (request, reply) => {
      const { name } = request.params;
      const workflow = findWorkflow(name);

      if (!workflow) {
        return sendError(reply, 404, `Workflow '${name}' not found`, 'NOT_FOUND');
      }

      const abortController = new AbortController();
      onClientDisconnect(reply, () => abortController.abort());

      try {
        const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
        const executor = new WorkflowExecutor(fastify.cogitator.runtime);

        const result = await executor.execute(workflow, request.body?.input, {
          ...executorOptions(request.body),
          signal: abortController.signal,
        });

        if (result.error) {
          return sendError(
            reply,
            500,
            `Workflow failed: ${resolveError(request, result.error, 'workflow run error').message}`,
            'WORKFLOW_FAILED'
          );
        }

        const response: WorkflowRunResponse = {
          workflowId: result.workflowId,
          workflowName: result.workflowName,
          state: result.state,
          duration: result.duration,
          nodeResults: Object.fromEntries(result.nodeResults),
        };

        return response;
      } catch (error) {
        if (isModuleNotFound(error)) {
          return sendError(reply, 501, WORKFLOWS_MISSING, 'UNIMPLEMENTED');
        }
        return sendRouteError(request, reply, error, 'workflow run error');
      }
    }
  );

  fastify.post<{ Params: WorkflowParams; Body: WorkflowRunRequest }>(
    '/workflows/:name/stream',
    {
      schema: { params: paramsSchema, body: WorkflowRunRequestSchema },
      preValidation: workflowBody,
    },
    async (request, reply) => {
      const { name } = request.params;
      const workflow = findWorkflow(name);

      if (!workflow) {
        return sendError(reply, 404, `Workflow '${name}' not found`, 'NOT_FOUND');
      }

      const writer = new FastifyStreamWriter(reply, {
        heartbeatMs: fastify.cogitator.sseHeartbeatMs,
      });
      const messageId = generateId('wf');
      const abortController = new AbortController();

      onClientDisconnect(reply, () => {
        abortController.abort();
        writer.close();
      });

      try {
        const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
        const executor = new WorkflowExecutor(fastify.cogitator.runtime);

        writer.start(messageId);

        const result = await executor.execute(workflow, request.body?.input, {
          ...executorOptions(request.body),
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
              error: resolveError(request, error, `workflow node ${node} error`).message,
            });
          },
          onNodeProgress: (node: string, progress: number) => {
            writer.workflowEvent('node_progress', { nodeName: node, progress });
          },
        });

        if (result.error) {
          writer.error(
            `Workflow failed: ${resolveError(request, result.error, 'workflow stream error').message}`,
            'WORKFLOW_FAILED'
          );
        } else {
          writer.workflowEvent('workflow_completed', {
            workflowId: result.workflowId,
            duration: result.duration,
          });
          writer.finish(messageId);
        }
      } catch (error) {
        if (isModuleNotFound(error)) {
          return sendError(reply, 501, WORKFLOWS_MISSING, 'UNIMPLEMENTED');
        }
        if (!abortController.signal.aborted) {
          const resolved = resolveError(request, error, 'workflow stream error');
          writer.error(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }

      return reply;
    }
  );
};
