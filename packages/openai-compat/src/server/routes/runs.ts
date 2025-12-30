/**
 * Runs API Routes
 *
 * Implements OpenAI Runs API endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter';
import type {
  CreateRunRequest,
  SubmitToolOutputsRequest,
} from '../../types/openai-types';

export function registerRunRoutes(
  fastify: FastifyInstance,
  adapter: OpenAIAdapter
) {
  fastify.post<{ Params: { thread_id: string }; Body: CreateRunRequest }>(
    '/v1/threads/:thread_id/runs',
    async (request, reply) => {
      const thread = adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      try {
        const run = await adapter.createRun(
          request.params.thread_id,
          request.body
        );

        if (request.body.stream) {
          return handleStreamingRun(reply, adapter, request.params.thread_id, run.id);
        }

        return reply.status(201).send(run);
      } catch (error) {
        return reply.status(400).send({
          error: {
            message: error instanceof Error ? error.message : 'Failed to create run',
            type: 'invalid_request_error',
            code: 'invalid_request',
          },
        });
      }
    }
  );

  fastify.post<{
    Body: CreateRunRequest & { thread?: { messages?: { role: 'user' | 'assistant'; content: string }[] } };
  }>(
    '/v1/threads/runs',
    async (request, reply) => {
      const thread = adapter.createThread();

      if (request.body.thread?.messages) {
        for (const msg of request.body.thread.messages) {
          adapter.addMessage(thread.id, msg);
        }
      }

      try {
        const run = await adapter.createRun(thread.id, request.body);

        if (request.body.stream) {
          return handleStreamingRun(reply, adapter, thread.id, run.id);
        }

        return reply.status(201).send(run);
      } catch (error) {
        return reply.status(400).send({
          error: {
            message: error instanceof Error ? error.message : 'Failed to create run',
            type: 'invalid_request_error',
            code: 'invalid_request',
          },
        });
      }
    }
  );

  fastify.get<{ Params: { thread_id: string; run_id: string } }>(
    '/v1/threads/:thread_id/runs/:run_id',
    async (request, reply) => {
      const run = adapter.getRun(
        request.params.thread_id,
        request.params.run_id
      );

      if (!run) {
        return reply.status(404).send({
          error: {
            message: `No run found with id '${request.params.run_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(run);
    }
  );

  fastify.post<{ Params: { thread_id: string; run_id: string } }>(
    '/v1/threads/:thread_id/runs/:run_id/cancel',
    async (request, reply) => {
      const run = adapter.cancelRun(
        request.params.thread_id,
        request.params.run_id
      );

      if (!run) {
        return reply.status(404).send({
          error: {
            message: `No run found with id '${request.params.run_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(run);
    }
  );

  fastify.post<{
    Params: { thread_id: string; run_id: string };
    Body: SubmitToolOutputsRequest;
  }>(
    '/v1/threads/:thread_id/runs/:run_id/submit_tool_outputs',
    async (request, reply) => {
      try {
        const run = await adapter.submitToolOutputs(
          request.params.thread_id,
          request.params.run_id,
          request.body
        );

        if (!run) {
          return reply.status(404).send({
            error: {
              message: `No run found with id '${request.params.run_id}'`,
              type: 'invalid_request_error',
              code: 'not_found',
            },
          });
        }

        if (request.body.stream) {
          return handleStreamingRun(reply, adapter, request.params.thread_id, run.id);
        }

        return reply.send(run);
      } catch (error) {
        return reply.status(400).send({
          error: {
            message: error instanceof Error ? error.message : 'Failed to submit tool outputs',
            type: 'invalid_request_error',
            code: 'invalid_request',
          },
        });
      }
    }
  );
}

/**
 * Handle streaming run response
 */
async function handleStreamingRun(
  reply: { raw: { write: (data: string) => void; end: () => void }; header: (key: string, value: string) => void },
  adapter: OpenAIAdapter,
  threadId: string,
  runId: string
) {
  reply.header('Content-Type', 'text/event-stream');
  reply.header('Cache-Control', 'no-cache');
  reply.header('Connection', 'keep-alive');

  const sendEvent = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let lastStatus = '';
  const maxIterations = 300;
  let iterations = 0;

  while (iterations < maxIterations) {
    const run = adapter.getRun(threadId, runId);
    if (!run) break;

    if (run.status !== lastStatus) {
      lastStatus = run.status;
      sendEvent(`thread.run.${run.status}`, run);
    }

    if (['completed', 'failed', 'cancelled', 'expired', 'incomplete'].includes(run.status)) {
      if (run.status === 'completed') {
        const messages = adapter.listMessages(threadId, { run_id: runId, limit: 1 });
        if (messages.length > 0) {
          sendEvent('thread.message.completed', messages[0]);
        }
      }
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    iterations++;
  }

  sendEvent('done', '[DONE]');
  reply.raw.end();
}
