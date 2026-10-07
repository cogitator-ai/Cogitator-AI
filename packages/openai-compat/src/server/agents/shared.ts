import { encodeHeartbeat, startHeartbeat } from '@cogitator-ai/server-shared';
import type { Agent, ImageInput } from '@cogitator-ai/types';
import { CogitatorError } from '@cogitator-ai/types';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { InvalidRequestError } from '../../client/errors';
import { formatOpenAIError } from '../middleware/error-handler';
import type { AgentTurnUsage } from './agent-turn';

type ImageMimeType = Extract<ImageInput, { mimeType: string }>['mimeType'];
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/** The agents the OpenAI endpoints serve, by the model id clients send. */
export class AgentDirectory {
  readonly createdAt = Math.floor(Date.now() / 1000);

  constructor(private readonly agents: Readonly<Record<string, Agent>>) {}

  get(model: string): Agent | undefined {
    return Object.hasOwn(this.agents, model) ? this.agents[model] : undefined;
  }

  names(): string[] {
    return Object.keys(this.agents);
  }
}

/** An image of a request, as the runtime takes it: a data URL becomes base64 data. */
export function toImageInput(url: string): ImageInput {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match && IMAGE_MIME_TYPES.has(match[1])) {
    return { data: match[2], mimeType: match[1] as ImageMimeType };
  }
  return url;
}

/** The body parsed with `schema`, or an `InvalidRequestError` naming the parameter at fault. */
export function parseRequestBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const param = issue.path.map(String).join('.');
  throw new InvalidRequestError(
    param ? `${param}: ${issue.message}` : issue.message,
    param || undefined
  );
}

export function sendModelNotFound(reply: FastifyReply, model: string): FastifyReply {
  return reply
    .status(404)
    .send(
      formatOpenAIError(
        'model_not_found',
        `The model '${model}' does not exist or you do not have access to it.`,
        'invalid_request_error',
        'model'
      )
    );
}

/** The message a client may see for a failed run: deliberate errors as they are, others masked. */
export function clientErrorMessage(error: unknown, context: string): string {
  if (error instanceof InvalidRequestError || CogitatorError.isCogitatorError(error)) {
    return error.message;
  }
  console.error(`[CogitatorOpenAI] ${context} failed:`, error);
  return 'Internal server error';
}

/** Answer a request that failed before any output was sent, in the OpenAI error format. */
export function sendTurnError(reply: FastifyReply, error: unknown, context: string): FastifyReply {
  if (error instanceof InvalidRequestError) {
    return reply
      .status(400)
      .send(
        formatOpenAIError('invalid_request', error.message, 'invalid_request_error', error.param)
      );
  }
  return reply
    .status(500)
    .send(formatOpenAIError('server_error', clientErrorMessage(error, context), 'server_error'));
}

/** Usage in the Chat Completions shape. */
export function chatUsage(usage: AgentTurnUsage) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

/** Usage in the Responses shape. */
export function responseUsage(usage: AgentTurnUsage) {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.totalTokens,
  };
}

/**
 * A signal that aborts when the client disconnects before the response is sent. It watches the
 * response, since the request emits `close` as soon as its body has been read.
 */
export function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) controller.abort(new Error('Client disconnected'));
  });
  return controller.signal;
}

export interface EventStream {
  /** Aborted when the client disconnects */
  signal: AbortSignal;
  write(frame: string): void;
  end(): void;
}

/**
 * Take over the reply for Server-Sent Events. While it is open a heartbeat comment goes out
 * every `heartbeatMs`, and the signal aborts when the client disconnects, so the run stops.
 */
export function openEventStream(reply: FastifyReply, heartbeatMs: number): EventStream {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const controller = new AbortController();
  raw.on('close', () => {
    if (!raw.writableFinished) controller.abort(new Error('Client disconnected'));
  });
  const writable = () => !controller.signal.aborted && !raw.writableEnded && !raw.destroyed;
  const stopHeartbeat = startHeartbeat(() => {
    if (!writable()) return false;
    raw.write(encodeHeartbeat());
    return true;
  }, heartbeatMs);
  return {
    signal: controller.signal,
    write(frame) {
      if (writable()) raw.write(frame);
    },
    end() {
      stopHeartbeat();
      if (!raw.writableEnded) raw.end();
    },
  };
}
