import { hook, HttpError, httpError, route } from '@tetsujs/core';
import type { BaseCtx } from '@tetsujs/core';
import { z } from 'zod';
import {
  INBOX_KINDS,
  INBOX_STATUSES,
  MAX_INBOX_PAGE,
  MAX_TRIGGER_BODY_BYTES,
  TRIGGER_BODY_TOO_LARGE,
  handleTriggerRoute,
  isJsonObject,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
} from '@cogitator-ai/server-shared';
import type {
  AnonymousPolicy,
  TriggerRouteAnswer,
  TriggersHost,
} from '@cogitator-ai/server-shared';
import type { anonymousHook, CallerHook } from './auth.js';
import { jsonBody } from './connection.js';
import type { cogitatorErrors } from './errors.js';
import { errorEnvelope } from './schemas.js';

const TriggerParams = z.object({
  id: z.string().min(1).describe('The trigger, `<routineId>.<triggerId>`'),
});

const TriggerFireResult = z.object({
  type: z.literal('routine_fire'),
  status: z.enum(['started', 'queued', 'skipped', 'duplicate']),
  eventId: z.string(),
  routineId: z.string().optional(),
  triggerId: z.string(),
  runId: z.string().optional(),
  threadId: z.string().optional(),
  reason: z.string().optional(),
});

const TriggerDuplicate = z
  .record(z.string(), z.unknown())
  .describe(
    'The event was delivered before (`status: duplicate`), or Slack asked to verify the URL'
  );

function triggerRefusal(description: string) {
  return z
    .object({ error: z.object({ code: z.string(), message: z.string() }) })
    .describe(
      `${description}. Answered in the envelope of the trigger routes of every adapter, \`{ error: { code, message } }\``
    );
}

const TRIGGER_REFUSALS = {
  401: triggerRefusal('The token or signature is not valid (`UNAUTHORIZED`)'),
  404: triggerRefusal('No such trigger, or not one for this route (`NOT_FOUND`)'),
  409: triggerRefusal('The trigger is paused (`TRIGGER_DISABLED`)'),
  413: triggerRefusal('The body is over 10 MiB (`PAYLOAD_TOO_LARGE`)'),
  429: triggerRefusal('The trigger took `maxPerHour` events in the last hour (`RATE_LIMITED`)'),
  500: triggerRefusal('The trigger manager failed (`INTERNAL_ERROR`)'),
};

/** A comma-separated list of `values`, as the inbox query takes them */
function commaList(values: readonly string[], description: string) {
  return z
    .string()
    .refine((value) => value.split(',').every((part) => values.includes(part.trim())), {
      message: `must be ${values.join(', ')}, comma-separated`,
    })
    .optional()
    .describe(description);
}

const InboxQuery = z.object({
  status: commaList(INBOX_STATUSES, 'Only items in these states: unread, read, archived'),
  kind: commaList(INBOX_KINDS, 'Only items of these kinds: result, approval, question, failure'),
  routineId: z.string().min(1).optional().describe('Only the items of this routine'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_INBOX_PAGE)
    .optional()
    .describe('Items on the page, newest first. Default: 50'),
  before: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Only items created before this time (ms), the `nextBefore` of the page before'),
  beforeId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'With `before`: also the items created at that time whose id sorts before this one, the `nextBeforeId` of the page before'
    ),
});

const InboxItem = z.object({
  id: z.string(),
  kind: z.enum(INBOX_KINDS),
  title: z.string(),
  summary: z.string(),
  body: z.string().optional(),
  status: z.enum(INBOX_STATUSES),
  createdAt: z.number().int(),
  updatedAt: z.number().int().optional(),
  answeredAt: z
    .number()
    .int()
    .optional()
    .describe('When a person answered the approval or question, set once'),
  routineId: z.string().optional(),
  triggerId: z.string().optional(),
  triggerEventId: z.string().optional(),
  source: z.string().optional(),
  runId: z.string().optional(),
  threadId: z.string().optional(),
  workflowRunId: z.string().optional(),
  approvalId: z.string().optional(),
  userId: z.string().optional(),
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const InboxPage = z.object({
  items: z.array(InboxItem),
  nextBefore: z
    .number()
    .int()
    .optional()
    .describe('Pass it as `before` to read the older items, absent on the last page'),
  nextBeforeId: z
    .string()
    .optional()
    .describe(
      'Pass it as `beforeId` with `before`, so items of the same millisecond are not skipped'
    ),
});

const InboxItemParams = z.object({ id: z.string().min(1) });
const InboxPatchBody = z.object({ status: z.enum(INBOX_STATUSES) }).strict();

const InboxItemNotFound = errorEnvelope('NOT_FOUND', "No such item of the caller's");
const InboxSignInRequired = errorEnvelope(
  'UNAUTHORIZED',
  "A caller without a user id, where the controller is not set to anonymous: 'allow'"
);

function send(answer: TriggerRouteAnswer): Response {
  return Response.json(answer.body, { status: answer.status, headers: answer.headers });
}

/**
 * The answer of an inbox route: a success as it is, a refusal thrown in the Tetsu envelope like
 * every other refusal of the controller
 */
function inboxAnswer(answer: TriggerRouteAnswer): Response {
  if (answer.status < 400) return send(answer);
  const error = isJsonObject(answer.body) ? answer.body.error : undefined;
  const code = isJsonObject(error) && typeof error.code === 'string' ? error.code : undefined;
  const message =
    isJsonObject(error) && typeof error.message === 'string' ? error.message : undefined;
  throw httpError(answer.status, code, message);
}

/** Answers a trigger body over {@link MAX_TRIGGER_BODY_BYTES} in the envelope of the trigger routes */
const triggerBodyTooLarge = hook.onError((ctx) =>
  ctx.error instanceof HttpError && ctx.error.status === 413
    ? send(TRIGGER_BODY_TOO_LARGE)
    : undefined
);

function requestOf(ctx: BaseCtx, rawBody: Uint8Array) {
  const ip = ctx.server.requestIP(ctx.req)?.address;
  return triggerRequestOf({
    method: ctx.req.method,
    headers: Object.fromEntries(ctx.req.headers),
    rawBody,
    query: Object.fromEntries(new URL(ctx.req.url).searchParams),
    ...(ip !== undefined && { ip }),
  });
}

interface Guards {
  caller: CallerHook;
  admitted: ReturnType<typeof anonymousHook>;
  errors: ReturnType<typeof cogitatorErrors>;
  /** The controller's anonymous policy as configured: the inbox needs `'allow'` for callers without a user id */
  anonymous: AnonymousPolicy | undefined;
}

/**
 * Experimental. The trigger and inbox routes of the controller, for `triggers`:
 * `POST /triggers/:id/fire` and `/webhook` run no `auth`, no anonymous policy and no JSON body
 * check, a trigger checks its caller itself by token or signature over the raw body, read as it
 * came whatever its content type. `GET /inbox` and `PATCH /inbox/:id` run behind them, a caller
 * sees and changes only their own items
 */
export function triggerRoutes(host: TriggersHost, { caller, admitted, errors, anonymous }: Guards) {
  return {
    fireTrigger: route({
      method: 'POST',
      path: '/triggers/:id/fire',
      bodyType: 'text',
      rawBody: true,
      maxBodySize: MAX_TRIGGER_BODY_BYTES,
      schema: {
        params: TriggerParams,
        response: {
          200: TriggerDuplicate,
          202: TriggerFireResult.describe(
            'The firing was taken: a run started, was queued or skipped (see `status`)'
          ),
          400: triggerRefusal('The body is not `{ text }` (`VALIDATION_ERROR`)'),
          ...TRIGGER_REFUSALS,
        },
      },
      hooks: { onError: [triggerBodyTooLarge, errors] },
      docs: {
        summary: 'Fire an API trigger',
        description:
          "Starts a session of the routine with its prompt as the task and `text` of a JSON body `{ text }` as untrusted data. Authenticated by the trigger's own bearer token, not by the controller's `auth`. `Idempotency-Key` makes repeats start one run",
        tags: ['triggers'],
      },
      handler: async (ctx) =>
        send(await handleTriggerRoute(host, 'fire', ctx.params.id, requestOf(ctx, ctx.rawBody))),
    }),

    deliverWebhook: route({
      method: 'POST',
      path: '/triggers/:id/webhook',
      bodyType: 'text',
      rawBody: true,
      maxBodySize: MAX_TRIGGER_BODY_BYTES,
      schema: {
        params: TriggerParams,
        response: {
          200: TriggerDuplicate,
          202: TriggerFireResult.describe(
            'The firing was taken: a run started, was queued or skipped (see `status`)'
          ),
          ...TRIGGER_REFUSALS,
        },
      },
      hooks: { onError: [triggerBodyTooLarge, errors] },
      docs: {
        summary: 'Deliver a webhook to a trigger',
        description:
          'A generic webhook signed with HMAC over the raw body, a GitHub delivery (`X-Hub-Signature-256`), inbound mail of Mailgun, Postmark or SendGrid, or a Slack Events API callback. The body is read as it came, any content type. The payload reaches the routine as untrusted data',
        tags: ['triggers'],
      },
      handler: async (ctx) =>
        send(await handleTriggerRoute(host, 'webhook', ctx.params.id, requestOf(ctx, ctx.rawBody))),
    }),

    listInbox: route({
      method: 'GET',
      path: '/inbox',
      schema: { query: InboxQuery, response: { 200: InboxPage, 401: InboxSignInRequired } },
      hooks: { beforeParse: [caller, admitted], onError: [errors] },
      docs: {
        summary: "The caller's inbox",
        description:
          "Results, failures, approvals and questions of routines, newest first: the items of the caller's user id. A caller without one gets 401 unless the controller is set to anonymous: 'allow', then the items of no user",
        tags: ['triggers'],
      },
      handler: async (ctx) => {
        const { limit, before, ...filter } = ctx.query;
        const query = {
          ...filter,
          ...(limit !== undefined && { limit: String(limit) }),
          ...(before !== undefined && { before: String(before) }),
        };
        return inboxAnswer(await listInboxRoute(host, query, ctx.cogitatorAuth?.userId, anonymous));
      },
    }),

    updateInboxItem: route({
      method: 'PATCH',
      path: '/inbox/:id',
      schema: {
        params: InboxItemParams,
        body: InboxPatchBody,
        response: { 200: InboxItem, 401: InboxSignInRequired, 404: InboxItemNotFound },
      },
      hooks: { beforeParse: [caller, admitted, jsonBody], onError: [errors] },
      docs: { summary: 'Mark an inbox item read, unread or archived', tags: ['triggers'] },
      handler: async (ctx) =>
        inboxAnswer(
          await patchInboxRoute(host, ctx.params.id, ctx.body, ctx.cogitatorAuth?.userId, anonymous)
        ),
    }),
  };
}
