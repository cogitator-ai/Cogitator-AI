/**
 * Runs API Routes
 *
 * Implements OpenAI Runs API endpoints.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter';
import { InvalidRequestError } from '../../client/errors';
import type {
  CreateMessageRequest,
  CreateRunRequest,
  ListResponse,
  Run,
  SubmitToolOutputsRequest,
} from '../../types/openai-types';
import { paginate, parseLimit, parseOrder, sendInvalidRequest, sendNotFound } from './shared';

export function registerRunRoutes(fastify: FastifyInstance, adapter: OpenAIAdapter) {
  fastify.post<{ Params: { thread_id: string }; Body: CreateRunRequest }>(
    '/v1/threads/:thread_id/runs',
    async (request, reply) => {
      const thread = await adapter.getThread(request.params.thread_id);
      if (!thread) {
        return sendNotFound(reply, 'thread', request.params.thread_id);
      }
      if (!request.body?.assistant_id) {
        return sendInvalidRequest(reply, 'assistant_id is required', 'assistant_id');
      }

      let run: Run;
      try {
        run = await adapter.createRun(request.params.thread_id, request.body);
      } catch (error) {
        return sendRequestError(reply, error);
      }

      if (request.body.stream) {
        return streamRun(reply, adapter, run.id, 0);
      }
      return reply.status(201).send(run);
    }
  );

  fastify.post<{
    Body: CreateRunRequest & {
      thread?: { messages?: CreateMessageRequest[]; metadata?: Record<string, string> };
    };
  }>('/v1/threads/runs', async (request, reply) => {
    if (!request.body?.assistant_id) {
      return sendInvalidRequest(reply, 'assistant_id is required', 'assistant_id');
    }
    if (!(await adapter.getAssistant(request.body.assistant_id))) {
      return sendInvalidRequest(reply, `Assistant ${request.body.assistant_id} not found`);
    }

    const thread = await adapter.createThread(request.body.thread?.metadata);
    for (const msg of request.body.thread?.messages ?? []) {
      await adapter.addMessage(thread.id, msg);
    }

    let run: Run;
    try {
      run = await adapter.createRun(thread.id, request.body);
    } catch (error) {
      await adapter.deleteThread(thread.id);
      return sendRequestError(reply, error);
    }

    if (request.body.stream) {
      return streamRun(reply, adapter, run.id, 0);
    }
    return reply.status(201).send(run);
  });

  fastify.get<{
    Params: { thread_id: string };
    Querystring: { limit?: string; order?: string; after?: string; before?: string };
  }>('/v1/threads/:thread_id/runs', async (request, reply) => {
    const thread = await adapter.getThread(request.params.thread_id);
    if (!thread) {
      return sendNotFound(reply, 'thread', request.params.thread_id);
    }

    const limit = parseLimit(request.query.limit);
    if (limit === null)
      return sendInvalidRequest(reply, 'limit must be between 1 and 100', 'limit');
    const order = parseOrder(request.query.order);
    if (order === null) return sendInvalidRequest(reply, "order must be 'asc' or 'desc'", 'order');

    const runs = adapter.listRuns(request.params.thread_id);
    const ordered = order === 'asc' ? runs.reverse() : runs;
    const page = paginate(ordered, {
      limit,
      after: request.query.after,
      before: request.query.before,
    });

    const response: ListResponse<Run> = { object: 'list', ...page };
    return reply.send(response);
  });

  fastify.get<{ Params: { thread_id: string; run_id: string } }>(
    '/v1/threads/:thread_id/runs/:run_id',
    async (request, reply) => {
      const run = adapter.getRun(request.params.thread_id, request.params.run_id);
      if (!run) {
        return sendNotFound(reply, 'run', request.params.run_id);
      }
      return reply.send(run);
    }
  );

  fastify.post<{ Params: { thread_id: string; run_id: string } }>(
    '/v1/threads/:thread_id/runs/:run_id/cancel',
    async (request, reply) => {
      let run: Run | undefined;
      try {
        run = adapter.cancelRun(request.params.thread_id, request.params.run_id);
      } catch (error) {
        return sendRequestError(reply, error);
      }
      if (!run) {
        return sendNotFound(reply, 'run', request.params.run_id);
      }
      return reply.send(run);
    }
  );

  fastify.post<{
    Params: { thread_id: string; run_id: string };
    Body: SubmitToolOutputsRequest;
  }>('/v1/threads/:thread_id/runs/:run_id/submit_tool_outputs', async (request, reply) => {
    const cursor = adapter.getRunEventCursor(request.params.run_id);

    let run: Run | undefined;
    try {
      run = await adapter.submitToolOutputs(
        request.params.thread_id,
        request.params.run_id,
        request.body ?? { tool_outputs: [] }
      );
    } catch (error) {
      return sendRequestError(reply, error);
    }

    if (!run) {
      return sendNotFound(reply, 'run', request.params.run_id);
    }

    if (request.body?.stream) {
      return streamRun(reply, adapter, run.id, cursor);
    }
    return reply.send(run);
  });
}

/**
 * Answer a refused request with 400 and its message; rethrow anything else
 * for the error handler, which hides the details of server failures.
 */
function sendRequestError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof InvalidRequestError) {
    return sendInvalidRequest(reply, error.message, error.param);
  }
  throw error;
}

/**
 * Stream run events as OpenAI-style server-sent events until the run
 * finishes or pauses for tool outputs.
 */
async function streamRun(
  reply: FastifyReply,
  adapter: OpenAIAdapter,
  runId: string,
  fromIndex: number
): Promise<FastifyReply> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  raw.on('close', () => {
    closed = true;
  });

  const events = adapter.streamRunEvents(runId, fromIndex);
  try {
    for await (const { event, data } of events) {
      if (closed || raw.writableEnded) break;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      raw.write(`event: ${event}\ndata: ${payload}\n\n`);
    }
  } finally {
    await events.return(undefined);
    if (!raw.writableEnded) raw.end();
  }
  return reply;
}
