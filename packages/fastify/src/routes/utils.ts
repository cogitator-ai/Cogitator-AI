import type { FastifyReply, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import {
  INTERNAL_ERROR,
  authorizeThreadAccess,
  describeHttpError,
  errorEnvelope,
  errorHeaders,
  type HttpErrorDescription,
  type ParseResult,
} from '@cogitator-ai/server-shared';

/** Answers an error with the shared envelope and its `Retry-After` */
export function sendFailure(reply: FastifyReply, error: HttpErrorDescription): FastifyReply {
  return reply.status(error.status).headers(errorHeaders(error)).send(errorEnvelope(error));
}

export function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  code: string
): FastifyReply {
  return sendFailure(reply, { status, code, message });
}

export function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
  );
}

/**
 * What a client may see of an error: what `describeHttpError` makes of it, or, for an
 * internal error, `500 Internal server error` after it is logged through `source.log`
 * (a request or the server)
 */
export function resolveError(
  source: Pick<FastifyRequest, 'log'>,
  error: unknown,
  label: string
): HttpErrorDescription {
  const described = describeHttpError(error);
  if (described) return described;
  source.log.error({ err: error }, label);
  return INTERNAL_ERROR;
}

export function sendRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  label: string
): FastifyReply {
  return sendFailure(reply, resolveError(request, error, label));
}

export function onClientDisconnect(reply: FastifyReply, handler: () => void): void {
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) handler();
  });
}

/**
 * A `preValidation` hook that reads the body with the shared validator every adapter uses
 * and puts the validated value in its place. It runs before the JSON schema, whose type
 * coercion would otherwise turn `input: 42` into `"42"`, so Fastify refuses exactly what
 * the other adapters refuse, and the schema only documents the body.
 */
export function validateBody<T>(
  parse: (body: unknown) => ParseResult<T>
): preValidationAsyncHookHandler {
  return async (request, reply) => {
    const parsed = parse(request.body);
    if (!parsed.ok) return sendError(reply, 400, parsed.message, 'INVALID_INPUT');
    request.body = parsed.value;
  };
}

/** {@link validateBody} for the query string */
export function validateQuery<T>(
  parse: (query: Record<string, unknown>) => ParseResult<T>
): preValidationAsyncHookHandler {
  return async (request, reply) => {
    const parsed = parse(request.query as Record<string, unknown>);
    if (!parsed.ok) return sendError(reply, 400, parsed.message, 'INVALID_INPUT');
    request.query = parsed.value;
  };
}

/**
 * Answers the refusal `authorizeThread` gives a request on the thread it names, and says
 * whether it did: `false` when the request may go on
 */
export async function refuseThread(
  request: FastifyRequest,
  reply: FastifyReply,
  threadId: string | undefined
): Promise<boolean> {
  const refusal = await authorizeThreadAccess(
    request.server.cogitator.authorizeThread,
    request.cogitatorAuth,
    threadId
  );
  if (!refusal) return false;
  sendFailure(reply, refusal);
  return true;
}

/** The `deps` an agent run gets for a request from the `deps` hook, none without the hook */
export async function requestDeps(request: FastifyRequest): Promise<{ deps?: unknown }> {
  const { deps } = request.server.cogitator;
  return deps ? { deps: await deps(request) } : {};
}
