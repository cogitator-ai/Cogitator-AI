import { createHmac } from 'node:crypto';
import type {
  InboxFilter,
  InboxItem,
  InboxItemPatch,
  TriggerHttpRequest,
  TriggerHttpResponse,
} from '@cogitator-ai/types';
import type { TriggersHost } from './triggers.js';

/**
 * Experimental. The trigger and inbox cases every adapter passes: raw bodies reach the trigger
 * untouched (JSON and forms alike), trigger routes check their caller themselves and ignore the
 * adapter's auth, the inbox shows and changes only the caller's items
 */

/** The token of the API trigger of the cases */
export const TRIGGER_CONFORMANCE_TOKEN = 'conformance-token';
/** The HMAC secret of the webhook trigger of the cases */
export const TRIGGER_CONFORMANCE_SECRET = 'conformance-secret';

/** The HMAC SHA-256 of a body as the webhook of the cases signs it */
export function triggerConformanceSignature(body: string): string {
  return `sha256=${createHmac('sha256', TRIGGER_CONFORMANCE_SECRET).update(body).digest('hex')}`;
}

function bodyText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf-8');
}

function headerOf(request: TriggerHttpRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== name) continue;
    return typeof value === 'string' ? value : value?.[0];
  }
  return undefined;
}

function seedItems(): InboxItem[] {
  return [
    {
      id: 'i-alice',
      kind: 'result',
      title: 'Digest',
      summary: 'quiet',
      status: 'unread',
      createdAt: 3,
      userId: 'alice',
    },
    {
      id: 'i-alice-old',
      kind: 'result',
      title: 'Old',
      summary: '',
      status: 'read',
      createdAt: 1,
      userId: 'alice',
    },
    {
      id: 'i-anon',
      kind: 'failure',
      title: 'Failed',
      summary: 'boom',
      status: 'unread',
      createdAt: 2,
    },
  ];
}

/**
 * The trigger manager of the cases: the API trigger `daily.api` takes {@link TRIGGER_CONFORMANCE_TOKEN},
 * the webhook `daily.webhook` checks {@link triggerConformanceSignature} of the raw body in
 * `x-signature`, anything else is not found. It remembers what it was handed
 */
export class ConformanceTriggers implements TriggersHost {
  readonly requests: { id: string; route: 'fire' | 'webhook'; request: TriggerHttpRequest }[] = [];
  private items = seedItems();

  readonly inbox = {
    list: async (filter?: InboxFilter): Promise<InboxItem[]> => {
      const statuses =
        filter?.status === undefined ? undefined : ([] as string[]).concat(filter.status);
      return this.items
        .filter((item) =>
          filter?.userId === null
            ? item.userId === undefined
            : filter?.userId === undefined || item.userId === filter.userId
        )
        .filter((item) => statuses === undefined || statuses.includes(item.status))
        .filter(
          (item) =>
            filter?.before === undefined ||
            item.createdAt < filter.before ||
            (filter.beforeId !== undefined &&
              item.createdAt === filter.before &&
              item.id < filter.beforeId)
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, filter?.limit ?? 50)
        .map((item) => ({ ...item }));
    },
    get: async (id: string): Promise<InboxItem | null> => {
      const item = this.items.find((candidate) => candidate.id === id);
      return item ? { ...item } : null;
    },
    update: async (id: string, patch: InboxItemPatch): Promise<InboxItem | null> => {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) return null;
      if (patch.status !== undefined) item.status = patch.status;
      return { ...item };
    },
  };

  private fired(id: string) {
    return {
      type: 'routine_fire' as const,
      status: 'started' as const,
      eventId: `evt_${this.requests.length}`,
      routineId: 'daily',
      triggerId: id,
      runId: `trg_${id}_${this.requests.length}`,
      threadId: `routine_daily_${this.requests.length}`,
    };
  }

  async handle(
    id: string,
    route: 'fire' | 'webhook',
    request: TriggerHttpRequest
  ): Promise<TriggerHttpResponse> {
    this.requests.push({ id, route, request });
    const body = bodyText(request.rawBody);
    if (route === 'fire' && id === 'daily.api') {
      if (headerOf(request, 'authorization') !== `Bearer ${TRIGGER_CONFORMANCE_TOKEN}`) {
        return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Bad token' } } };
      }
      return { status: 202, body: { ...this.fired(id), body } };
    }
    if (route === 'webhook' && id === 'daily.webhook') {
      if (headerOf(request, 'x-signature') !== triggerConformanceSignature(body)) {
        return {
          status: 401,
          body: { error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } },
        };
      }
      return { status: 202, body: { ...this.fired(id), body } };
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: `No trigger ${id}` } } };
  }
}

/** One trigger or inbox case */
export interface TriggerConformanceCase {
  name: string;
  method: 'GET' | 'POST' | 'PATCH';
  /** Relative to where the adapter is mounted */
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /**
   * The adapter's anonymous policy as configured (unset: none), and whether it gets the triggers
   * at all (default: yes)
   */
  server?: { anonymous?: 'allow' | 'deny'; triggers?: false };
  expect: {
    status: number;
    code?: string;
    /** Fields the JSON answer must have, compared exactly */
    json?: Readonly<Record<string, unknown>>;
    /** The ids of the inbox items of the answer, in order */
    items?: readonly string[];
    /** The raw body the trigger must have been handed */
    received?: string;
  };
}

const ALICE = { 'x-conformance-user': 'alice', 'x-conformance-role': 'member' } as const;
const MALLORY = { 'x-conformance-user': 'mallory', 'x-conformance-role': 'member' } as const;
const FIRE_BODY = '{"text":"run it",  "spaced": true}';
const FORM_BODY = 'subject=Hello+there&body-plain=It%27s+me';
const JSON_HOOK = '{ "zen":"keep it logically awesome" }';

export const TRIGGER_CONFORMANCE_CASES: readonly TriggerConformanceCase[] = [
  {
    name: 'fires an API trigger with the raw JSON body as sent',
    method: 'POST',
    path: '/triggers/daily.api/fire',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TRIGGER_CONFORMANCE_TOKEN}`,
    },
    body: FIRE_BODY,
    expect: { status: 202, json: { status: 'started', body: FIRE_BODY }, received: FIRE_BODY },
  },
  {
    name: 'lets the trigger refuse a wrong token',
    method: 'POST',
    path: '/triggers/daily.api/fire',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: FIRE_BODY,
    expect: { status: 401, code: 'UNAUTHORIZED' },
  },
  {
    name: 'hands a signed JSON webhook its exact bytes',
    method: 'POST',
    path: '/triggers/daily.webhook/webhook',
    headers: {
      'content-type': 'application/json',
      'x-signature': triggerConformanceSignature(JSON_HOOK),
    },
    body: JSON_HOOK,
    expect: { status: 202, received: JSON_HOOK },
  },
  {
    name: 'hands a form webhook its exact bytes, unparsed',
    method: 'POST',
    path: '/triggers/daily.webhook/webhook',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-signature': triggerConformanceSignature(FORM_BODY),
    },
    body: FORM_BODY,
    expect: { status: 202, received: FORM_BODY },
  },
  {
    name: 'takes a signed webhook without the adapter auth an anonymous policy asks for',
    method: 'POST',
    path: '/triggers/daily.webhook/webhook',
    headers: {
      'content-type': 'application/json',
      'x-signature': triggerConformanceSignature(JSON_HOOK),
    },
    body: JSON_HOOK,
    server: { anonymous: 'deny' },
    expect: { status: 202 },
  },
  {
    name: 'answers a trigger that does not exist as the manager does',
    method: 'POST',
    path: '/triggers/missing.api/fire',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    expect: { status: 404, code: 'NOT_FOUND' },
  },
  {
    name: 'refuses an anonymous caller the inbox unless the server allows anonymous callers',
    method: 'GET',
    path: '/inbox',
    expect: { status: 401, code: 'UNAUTHORIZED' },
  },
  {
    name: 'refuses an anonymous caller a change to the inbox unless the server allows them',
    method: 'PATCH',
    path: '/inbox/i-anon',
    headers: { 'content-type': 'application/json' },
    body: '{"status":"read"}',
    expect: { status: 401, code: 'UNAUTHORIZED' },
  },
  {
    name: 'shows an anonymous caller only the items without a user where the server allows them',
    method: 'GET',
    path: '/inbox',
    server: { anonymous: 'allow' },
    expect: { status: 200, items: ['i-anon'] },
  },
  {
    name: 'shows a caller their items, newest first',
    method: 'GET',
    path: '/inbox',
    headers: ALICE,
    expect: { status: 200, items: ['i-alice', 'i-alice-old'] },
  },
  {
    name: 'filters the inbox by status',
    method: 'GET',
    path: '/inbox?status=unread',
    headers: ALICE,
    expect: { status: 200, items: ['i-alice'] },
  },
  {
    name: 'pages the inbox',
    method: 'GET',
    path: '/inbox?limit=1',
    headers: ALICE,
    expect: { status: 200, items: ['i-alice'], json: { nextBefore: 3, nextBeforeId: 'i-alice' } },
  },
  {
    name: 'pages on from the cursor of the page before',
    method: 'GET',
    path: '/inbox?limit=1&before=3&beforeId=i-alice',
    headers: ALICE,
    expect: { status: 200, items: ['i-alice-old'] },
  },
  {
    name: 'refuses a limit out of range',
    method: 'GET',
    path: '/inbox?limit=0',
    headers: ALICE,
    expect: { status: 400, code: 'INVALID_INPUT' },
  },
  {
    name: 'marks an item of the caller read',
    method: 'PATCH',
    path: '/inbox/i-alice',
    headers: { ...ALICE, 'content-type': 'application/json' },
    body: '{"status":"read"}',
    expect: { status: 200, json: { id: 'i-alice', status: 'read' } },
  },
  {
    name: 'does not let a caller touch an item of another user',
    method: 'PATCH',
    path: '/inbox/i-alice',
    headers: { ...MALLORY, 'content-type': 'application/json' },
    body: '{"status":"archived"}',
    expect: { status: 404, code: 'NOT_FOUND' },
  },
  {
    name: 'refuses a status that does not exist',
    method: 'PATCH',
    path: '/inbox/i-alice',
    headers: { ...ALICE, 'content-type': 'application/json' },
    body: '{"status":"deleted"}',
    expect: { status: 400, code: 'INVALID_INPUT' },
  },
  {
    name: 'serves no trigger routes without triggers',
    method: 'POST',
    path: '/triggers/daily.api/fire',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TRIGGER_CONFORMANCE_TOKEN}`,
    },
    body: FIRE_BODY,
    server: { triggers: false },
    expect: { status: 404 },
  },
];

/** What an adapter answered to a case */
export interface TriggerConformanceResponse {
  status: number;
  body: string;
}

function codeOf(json: unknown): string | undefined {
  const error = (json as { error?: unknown } | null)?.error;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return typeof (json as { code?: unknown } | null)?.code === 'string'
    ? (json as { code: string }).code
    : undefined;
}

/** What is wrong with an adapter's answer to a case, empty when nothing is */
export function checkTriggerConformanceCase(
  testCase: TriggerConformanceCase,
  response: TriggerConformanceResponse,
  host: ConformanceTriggers
): string[] {
  const problems: string[] = [];
  const { expect } = testCase;
  if (response.status !== expect.status) {
    problems.push(
      `status ${response.status}, expected ${expect.status}: ${response.body.slice(0, 200)}`
    );
    return problems;
  }
  let json: unknown;
  try {
    json = response.body === '' ? undefined : (JSON.parse(response.body) as unknown);
  } catch {
    json = undefined;
  }
  if (expect.code !== undefined && codeOf(json) !== expect.code) {
    problems.push(`code ${String(codeOf(json))}, expected ${expect.code}`);
  }
  for (const [key, value] of Object.entries(expect.json ?? {})) {
    const got = (json as Record<string, unknown> | undefined)?.[key];
    if (JSON.stringify(got) !== JSON.stringify(value)) {
      problems.push(`${key} is ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`);
    }
  }
  if (expect.items !== undefined) {
    const items = (json as { items?: { id: string }[] } | undefined)?.items?.map((item) => item.id);
    if (JSON.stringify(items) !== JSON.stringify(expect.items)) {
      problems.push(`items ${JSON.stringify(items)}, expected ${JSON.stringify(expect.items)}`);
    }
  }
  if (expect.received !== undefined) {
    const last = host.requests[host.requests.length - 1];
    const got = last ? bodyText(last.request.rawBody) : undefined;
    if (got !== expect.received) {
      problems.push(
        `the trigger got ${JSON.stringify(got)}, expected ${JSON.stringify(expect.received)}`
      );
    }
  }
  return problems;
}
