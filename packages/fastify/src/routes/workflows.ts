import type { FastifyPluginAsync } from 'fastify';
import type { WorkflowListResponse, WorkflowRunRequest, WorkflowRunResponse } from '../types.js';
import { WorkflowRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import { CogitatorError } from '@cogitator-ai/types';

interface WorkflowParams {
  name: string;
}

export const workflowRoutes: FastifyPluginAsync = async (fastify) => {
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
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: WorkflowRunRequestSchema,
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const workflow = Object.hasOwn(fastify.cogitator.workflows, name)
        ? fastify.cogitator.workflows[name]
        : undefined;

      if (!workflow) {
        return reply.status(404).send({
          error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      try {
        const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
        const executor = new WorkflowExecutor(fastify.cogitator.runtime);

        const result = await executor.execute(workflow, request.body?.input, request.body?.options);

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

        return response;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
          return reply.status(501).send({
            error: { message: 'Workflows package not installed', code: 'UNIMPLEMENTED' },
          });
        }

        if (CogitatorError.isCogitatorError(error)) {
          return reply.status(500).send({ error: { message: error.message, code: error.code } });
        }
        request.log.error({ err: error }, 'workflow run error');
        return reply
          .status(500)
          .send({ error: { message: 'Internal server error', code: 'INTERNAL' } });
      }
    }
  );

  fastify.post<{ Params: WorkflowParams; Body: WorkflowRunRequest }>(
    '/workflows/:name/stream',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: WorkflowRunRequestSchema,
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const workflow = Object.hasOwn(fastify.cogitator.workflows, name)
        ? fastify.cogitator.workflows[name]
        : undefined;

      if (!workflow) {
        return reply.status(404).send({
          error: { message: `Workflow '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      const writer = new FastifyStreamWriter(reply);
      const messageId = generateId('wf');

      request.raw.on('close', () => {
        writer.close();
      });

      try {
        const { WorkflowExecutor } = await import('@cogitator-ai/workflows');
        const executor = new WorkflowExecutor(fastify.cogitator.runtime);

        writer.start(messageId);

        const userOptions = request.body?.options ?? {};
        const result = await executor.execute(workflow, request.body?.input, {
          maxConcurrency: userOptions.maxConcurrency,
          maxIterations: userOptions.maxIterations,
          checkpoint: userOptions.checkpoint,
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
        if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
          writer.error('Workflows package not installed', 'UNIMPLEMENTED');
        } else if (CogitatorError.isCogitatorError(error)) {
          writer.error(error.message, error.code);
        } else {
          request.log.error({ err: error }, 'workflow stream error');
          writer.error('Internal server error', 'INTERNAL');
        }
      } finally {
        writer.close();
      }
    }
  );
};
