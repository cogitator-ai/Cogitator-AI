import {
  MAX_TRIGGER_BODY_BYTES,
  TRIGGER_BODY_TOO_LARGE,
  admitCaller,
  handleTriggerRoute,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
  type TriggerRouteAnswer,
  type TriggersHost,
} from '@cogitator-ai/server-shared';
import type { InboxCaller, InboxHandlerOptions, RouteParams } from '../types.js';
import {
  errorResponse,
  exceedsDeclaredSize,
  hookErrorResponse,
  jsonError,
  jsonResponse,
  readJsonBody,
  runErrorResponse,
} from './http.js';

function send(answer: TriggerRouteAnswer): Response {
  return jsonResponse(answer.body, answer.status, answer.headers);
}

/**
 * The bytes of the body as the client sent them, `undefined` past `limit`. Read chunk by chunk,
 * so a body without a `content-length` stops at the limit too
 */
async function readRawBody(req: Request, limit: number): Promise<Uint8Array | undefined> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The first value of each query parameter */
function queryOf(req: Request): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(req.url).searchParams) {
    if (!(key in query)) query[key] = value;
  }
  return query;
}

/**
 * Experimental. The route handler of the triggers of the runtime's trigger manager
 * (`cog.experimental_triggers`), `POST` of `app/api/triggers/[id]/[route]/route.ts`:
 * `/triggers/:id/fire` fires an API trigger, `/triggers/:id/webhook` delivers a webhook. It runs
 * no auth of its own, a trigger checks its caller by token or signature over the raw body, read
 * as it came whatever its content type. Any other `route` answers `404`
 *
 * @example
 * ```ts
 * // app/api/triggers/[id]/[route]/route.ts
 * export const POST = createTriggerHandler(cog.experimental_triggers);
 * ```
 */
export function createTriggerHandler(host: TriggersHost) {
  return async (
    req: Request,
    context: { params: RouteParams<{ id: string; route: string }> }
  ): Promise<Response> => {
    const { id, route } = await context.params;
    if (route !== 'fire' && route !== 'webhook') {
      return jsonError(`No trigger route '${route}'`, 404, 'NOT_FOUND');
    }
    if (exceedsDeclaredSize(req, MAX_TRIGGER_BODY_BYTES)) return send(TRIGGER_BODY_TOO_LARGE);
    let rawBody: Uint8Array | undefined;
    try {
      rawBody = await readRawBody(req, MAX_TRIGGER_BODY_BYTES);
    } catch {
      return jsonError('Failed to read request body', 400, 'INVALID_INPUT');
    }
    if (!rawBody) return send(TRIGGER_BODY_TOO_LARGE);
    return send(
      await handleTriggerRoute(
        host,
        route,
        id,
        triggerRequestOf({
          method: req.method,
          headers: Object.fromEntries(req.headers),
          rawBody,
          query: queryOf(req),
        })
      )
    );
  };
}

type Admission = { ok: true; userId: string | undefined } | { ok: false; response: Response };

/**
 * Experimental. The route handlers of the inbox of the runtime's trigger manager
 * (`cog.experimental_triggers`): `GET` lists the caller's items (`app/api/inbox/route.ts`),
 * `PATCH` marks one read, unread or archived (`app/api/inbox/[id]/route.ts`). A caller sees and
 * changes only the items of the user id `auth` returns. A caller without one (no `auth`, or no
 * `userId`) gets `401` unless `anonymous: 'allow'` is set, then they see the items without a user
 *
 * @example
 * ```ts
 * const inbox = createInboxHandler(cog.experimental_triggers, {
 *   auth: async (req) => ({ userId: await userIdOf(req) }),
 * });
 * // app/api/inbox/route.ts
 * export const { GET } = inbox;
 * // app/api/inbox/[id]/route.ts
 * export const { PATCH } = inbox;
 * ```
 */
export function createInboxHandler(host: TriggersHost, options: InboxHandlerOptions = {}) {
  const admit = async (req: Request): Promise<Admission> => {
    let caller: InboxCaller | undefined;
    try {
      caller = await options.auth?.(req);
    } catch (err) {
      return { ok: false, response: hookErrorResponse(err, 'Unauthorized') };
    }
    const userId = caller?.userId;
    const refusal = admitCaller(userId, options.anonymous);
    return refusal ? { ok: false, response: errorResponse(refusal) } : { ok: true, userId };
  };

  return {
    GET: async (req: Request): Promise<Response> => {
      const admitted = await admit(req);
      if (!admitted.ok) return admitted.response;
      try {
        return send(await listInboxRoute(host, queryOf(req), admitted.userId, options.anonymous));
      } catch (err) {
        return runErrorResponse(err);
      }
    },
    PATCH: async (
      req: Request,
      context: { params: RouteParams<{ id: string }> }
    ): Promise<Response> => {
      const admitted = await admit(req);
      if (!admitted.ok) return admitted.response;
      const { id } = await context.params;
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      try {
        return send(await patchInboxRoute(host, id, body.body, admitted.userId, options.anonymous));
      } catch (err) {
        return runErrorResponse(err);
      }
    },
  };
}
