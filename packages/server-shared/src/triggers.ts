import type {
  InboxFilter,
  InboxItem,
  InboxItemKind,
  InboxItemPatch,
  InboxItemStatus,
  TriggerHttpRequest,
  TriggerHttpResponse,
} from '@cogitator-ai/types';
import { z } from 'zod';

/**
 * Experimental. The routes of triggers and the inbox every adapter serves when given `triggers`
 * (the runtime's `cog.experimental_triggers`):
 * - `POST /triggers/:id/fire`: an API trigger, `Authorization: Bearer <token>`, `{ "text": "..." }`
 * - `POST /triggers/:id/webhook`: a webhook, GitHub, email or Slack trigger, signed by its sender
 * - `GET /inbox`: the caller's inbox items, `?status=unread&kind=failure&limit=20&before=<ms>`
 * - `PATCH /inbox/:id`: `{ "status": "read" | "unread" | "archived" }`
 *
 * The two trigger routes check their caller themselves (token, signature) and read the raw body,
 * so they run before the adapter's own auth and JSON body parsing. The inbox routes go through
 * the adapter's auth: a caller sees and changes only items of their user id, an anonymous caller
 * only items without one
 */
export const TRIGGER_ROUTES = {
  fire: '/triggers/:id/fire',
  webhook: '/triggers/:id/webhook',
  inbox: '/inbox',
  inboxItem: '/inbox/:id',
} as const;

/** The largest body a trigger route reads: 10 MiB, for mail with attachments */
export const MAX_TRIGGER_BODY_BYTES = 10 * 1024 * 1024;

/** What the routes need of the trigger manager: `cog.experimental_triggers` is one */
export interface TriggersHost {
  handle(
    id: string,
    route: 'fire' | 'webhook',
    request: TriggerHttpRequest
  ): Promise<TriggerHttpResponse>;
  readonly inbox: {
    list(filter?: InboxFilter): Promise<InboxItem[]>;
    get(id: string): Promise<InboxItem | null>;
    update(id: string, patch: InboxItemPatch): Promise<InboxItem | null>;
  };
}

/** An answer of the routes: a status, a JSON body and headers */
export interface TriggerRouteAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function refusal(status: number, code: string, message: string): TriggerRouteAnswer {
  return { status, body: { error: { code, message } } };
}

/** The refusal of a trigger request whose body is over {@link MAX_TRIGGER_BODY_BYTES} */
export const TRIGGER_BODY_TOO_LARGE: TriggerRouteAnswer = refusal(
  413,
  'PAYLOAD_TOO_LARGE',
  'Payload too large'
);

/**
 * Answers `POST /triggers/:id/fire` or `/webhook` with the raw body as received. A failure of
 * the manager is answered `500` without its details
 */
export async function handleTriggerRoute(
  host: TriggersHost,
  route: 'fire' | 'webhook',
  id: string,
  request: TriggerHttpRequest
): Promise<TriggerRouteAnswer> {
  const raw = request.rawBody;
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (size > MAX_TRIGGER_BODY_BYTES) return TRIGGER_BODY_TOO_LARGE;
  try {
    const answer = await host.handle(id, route, request);
    return {
      status: answer.status,
      body: answer.body,
      ...(answer.headers !== undefined && { headers: answer.headers }),
    };
  } catch {
    return refusal(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

/** The states of an inbox item, as `GET /inbox?status=` and `PATCH /inbox/:id` take them */
export const INBOX_STATUSES = [
  'unread',
  'read',
  'archived',
] as const satisfies readonly InboxItemStatus[];
/** The kinds of an inbox item, as `GET /inbox?kind=` takes them */
export const INBOX_KINDS = [
  'result',
  'approval',
  'question',
  'failure',
] as const satisfies readonly InboxItemKind[];
/** The most items one page of `GET /inbox` holds */
export const MAX_INBOX_PAGE = 200;
const STATUSES = INBOX_STATUSES;
const KINDS = INBOX_KINDS;

const listQuery = z.object({
  status: z.string().optional(),
  kind: z.string().optional(),
  routineId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_INBOX_PAGE).optional(),
  before: z.coerce.number().int().positive().optional(),
});

function listOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[]
): T[] | undefined | false {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((part) => part.trim());
  return parts.every((part): part is T => (allowed as readonly string[]).includes(part))
    ? (parts as T[])
    : false;
}

/**
 * Answers `GET /inbox`: `{ items, nextBefore? }`, newest first, the caller's items only.
 * `nextBefore` pages on to older items
 */
export async function listInboxRoute(
  host: TriggersHost,
  query: Readonly<Record<string, string | undefined>>,
  userId: string | undefined
): Promise<TriggerRouteAnswer> {
  const parsed = listQuery.safeParse(query);
  if (!parsed.success) {
    return refusal(400, 'INVALID_INPUT', 'limit is 1 to 200, before a time in ms');
  }
  const statuses = listOf<InboxItemStatus>(parsed.data.status, STATUSES);
  const kinds = listOf<InboxItemKind>(parsed.data.kind, KINDS);
  if (statuses === false || kinds === false) {
    return refusal(
      400,
      'INVALID_INPUT',
      'status is unread, read or archived, kind is result, approval, question or failure'
    );
  }
  const limit = parsed.data.limit ?? 50;
  const items = await host.inbox.list({
    userId: userId ?? null,
    limit: limit + 1,
    ...(statuses && { status: statuses }),
    ...(kinds && { kind: kinds }),
    ...(parsed.data.routineId !== undefined && { routineId: parsed.data.routineId }),
    ...(parsed.data.before !== undefined && { before: parsed.data.before }),
  });
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      items: page,
      ...(items.length > limit && last !== undefined && { nextBefore: last.createdAt }),
    },
  };
}

const patchBody = z.object({ status: z.enum(STATUSES) }).strict();

/** Answers `PATCH /inbox/:id`: the item after the change, `404` for an item of another user */
export async function patchInboxRoute(
  host: TriggersHost,
  id: string,
  body: unknown,
  userId: string | undefined
): Promise<TriggerRouteAnswer> {
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    return refusal(
      400,
      'INVALID_INPUT',
      'The body is { "status": "unread" | "read" | "archived" }'
    );
  }
  const item = await host.inbox.get(id);
  if (!item || item.userId !== userId) {
    return refusal(404, 'NOT_FOUND', `No inbox item '${id}'`);
  }
  const updated = await host.inbox.update(id, { status: parsed.data.status });
  return updated
    ? { status: 200, body: updated }
    : refusal(404, 'NOT_FOUND', `No inbox item '${id}'`);
}

/** The trigger request of a Node request: its method, headers, raw body, query and address */
export function triggerRequestOf(input: {
  method: string;
  headers: TriggerHttpRequest['headers'];
  rawBody: string | Uint8Array | undefined;
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  ip?: string;
}): TriggerHttpRequest {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.query ?? {})) {
    const first = typeof value === 'string' ? value : value?.[0];
    if (first !== undefined) query[key] = first;
  }
  return {
    method: input.method,
    headers: input.headers,
    rawBody: input.rawBody ?? '',
    query,
    ...(input.ip !== undefined && { ip: input.ip }),
  };
}
