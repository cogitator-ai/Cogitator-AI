/**
 * Reads the request of each kind of trigger into an event: checks who sent it, answers what is
 * not an event (Slack's URL check, GitHub's ping, an event the trigger does not take) and pulls
 * the text, sender and delivery id out of the payload
 */

import type {
  ApiTriggerSpec,
  EmailTriggerMail,
  EmailTriggerSpec,
  GitHubTriggerFilter,
  GitHubTriggerSpec,
  SlackTriggerSpec,
  TriggerEvent,
  TriggerHttpRequest,
  TriggerHttpResponse,
  TriggerState,
  WebhookTriggerSpec,
} from '@cogitator-ai/types';
import { experimental_createTriggerEvent } from './envelope';
import {
  resolveTriggerSecret,
  secretsEqual,
  triggerTokenMatches,
  verifyGitHubSignature,
  verifyHmacSignature,
  verifyMailgunSignature,
  verifySlackSignature,
} from './verify';

/** What a request comes to: an event to fire, or the answer to give without firing */
export type SourceOutcome =
  { kind: 'event'; event: TriggerEvent } | { kind: 'answer'; response: TriggerHttpResponse };

/** Who the request is for */
export interface SourceTarget {
  /** `<routineId>.<triggerId>` */
  triggerId: string;
  routineId: string;
}

/** Most characters of an API call's `text` */
export const MAX_FIRE_TEXT = 65_536;

export function answer(status: number, body: unknown): SourceOutcome {
  return { kind: 'answer', response: { status, body } };
}

function refused(status: number, code: string, message: string): SourceOutcome {
  return answer(status, { error: { code, message } });
}

/** The first value of a header, by its name in any case */
export function headerValue(
  headers: TriggerHttpRequest['headers'],
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower || value === undefined) continue;
    const first = typeof value === 'string' ? value : value[0];
    return first === undefined ? undefined : first;
  }
  return undefined;
}

export function bodyText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : Buffer.from(body).toString('utf-8');
}

function parseJson(body: string | Uint8Array): unknown {
  const text = bodyText(body);
  if (text.trim() === '') return undefined;
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' ? current : undefined;
}

/** A form body's fields, multipart or urlencoded: text fields as they are, files by name */
export async function readForm(
  body: string | Uint8Array,
  contentType: string
): Promise<Record<string, string>> {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const form = await new Response(new Uint8Array(bytes), {
    headers: { 'content-type': contentType },
  }).formData();
  const fields: Record<string, string> = {};
  form.forEach((value, key) => {
    fields[key] = typeof value === 'string' ? value : `[file ${value.name}]`;
  });
  return fields;
}

function isForm(contentType: string): boolean {
  return /^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(contentType);
}

/**
 * `POST /triggers/:id/fire` with `Authorization: Bearer <token>` and `{ "text": "..." }`. The token
 * is the spec's, else the one the manager issued (its hash is in `state`). `Idempotency-Key`, when
 * sent, makes repeats of the call start one run
 */
export function readApiFire(
  spec: ApiTriggerSpec,
  state: TriggerState | null,
  request: TriggerHttpRequest,
  target: SourceTarget
): SourceOutcome {
  const authorization = headerValue(request.headers, 'authorization');
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return refused(401, 'UNAUTHORIZED', 'A bearer token is required');
  const configured = resolveTriggerSecret(spec.token);
  const valid =
    configured !== undefined
      ? secretsEqual(token, configured)
      : state?.tokenHash !== undefined && triggerTokenMatches(token, state.tokenHash);
  if (!valid) return refused(401, 'UNAUTHORIZED', 'The token is not valid for this trigger');
  let text: string | undefined;
  try {
    const body = parseJson(request.rawBody);
    if (body !== undefined) {
      if (!isRecord(body)) return refused(400, 'VALIDATION_ERROR', 'The body must be an object');
      if (body.text !== undefined && typeof body.text !== 'string') {
        return refused(400, 'VALIDATION_ERROR', '`text` must be a string');
      }
      text = body.text;
    }
  } catch {
    return refused(400, 'VALIDATION_ERROR', 'The body is not valid JSON');
  }
  if (text !== undefined && text.length > MAX_FIRE_TEXT) {
    return refused(413, 'VALIDATION_ERROR', `\`text\` is longer than ${MAX_FIRE_TEXT} characters`);
  }
  const idempotencyKey = headerValue(request.headers, 'idempotency-key');
  return {
    kind: 'event',
    event: experimental_createTriggerEvent({
      source: 'api',
      ...target,
      verified: { method: 'bearer', ok: true },
      ...(text !== undefined && { text }),
      ...(idempotencyKey && { dedupKey: idempotencyKey }),
    }),
  };
}

/** A generic webhook signed with HMAC over the raw body */
export function readWebhook(
  spec: WebhookTriggerSpec,
  request: TriggerHttpRequest,
  target: SourceTarget
): SourceOutcome {
  const secret = resolveTriggerSecret(spec.secret);
  if (secret === undefined) {
    return refused(503, 'CONFIGURATION_ERROR', 'The webhook secret of this trigger is not set');
  }
  const signature = headerValue(request.headers, spec.signatureHeader ?? 'x-signature');
  if (!verifyHmacSignature(request.rawBody, signature, secret, spec.algorithm ?? 'sha256')) {
    return refused(401, 'UNAUTHORIZED', 'Invalid signature');
  }
  const contentType = headerValue(request.headers, 'content-type') ?? '';
  let payload: unknown;
  try {
    payload = /json/i.test(contentType) ? parseJson(request.rawBody) : bodyText(request.rawBody);
  } catch {
    return refused(400, 'VALIDATION_ERROR', 'The body is not valid JSON');
  }
  const delivery = spec.deliveryHeader
    ? headerValue(request.headers, spec.deliveryHeader)
    : undefined;
  return {
    kind: 'event',
    event: experimental_createTriggerEvent({
      source: 'webhook',
      ...target,
      verified: { method: 'hmac', ok: true },
      ...(payload !== undefined && { payload }),
      ...(typeof payload === 'string' && { text: payload }),
      ...(delivery && { dedupKey: delivery }),
    }),
  };
}

/** The value at a dot path of a payload */
export function valueAt(payload: unknown, path: string): unknown {
  let current = payload;
  for (const key of path.split('.')) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Whether a GitHub payload meets a filter */
export function matchesGitHubFilter(payload: unknown, filter: GitHubTriggerFilter): boolean {
  const value = valueAt(payload, filter.field);
  if (filter.equals !== undefined && value !== filter.equals) return false;
  if (filter.contains !== undefined) {
    if (typeof value === 'string') {
      if (!value.includes(filter.contains)) return false;
    } else if (Array.isArray(value)) {
      if (
        !value.some(
          (item) => item === filter.contains || stringAt(item, 'name') === filter.contains
        )
      ) {
        return false;
      }
    } else {
      return false;
    }
  }
  if (filter.matches !== undefined) {
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${filter.matches})$`);
    } catch {
      return false;
    }
    if (!pattern.test(String(value))) return false;
  }
  return true;
}

/** The text of a GitHub event a person wrote: a title and body, a comment, a review, release notes */
function gitHubText(payload: unknown): string | undefined {
  const parts: string[] = [];
  for (const key of ['pull_request', 'issue', 'release', 'discussion']) {
    const title = stringAt(payload, key, 'title') ?? stringAt(payload, key, 'name');
    const body = stringAt(payload, key, 'body');
    if (title) parts.push(title);
    if (body) parts.push(body);
  }
  for (const key of ['comment', 'review']) {
    const body = stringAt(payload, key, 'body');
    if (body) parts.push(body);
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** A GitHub webhook delivery: signature, event name, filters, delivery id */
export function readGitHub(
  spec: GitHubTriggerSpec,
  request: TriggerHttpRequest,
  target: SourceTarget
): SourceOutcome {
  const secret = resolveTriggerSecret(spec.secret);
  if (secret === undefined) {
    return refused(503, 'CONFIGURATION_ERROR', 'The webhook secret of this trigger is not set');
  }
  const signature = headerValue(request.headers, 'x-hub-signature-256');
  if (!verifyGitHubSignature(request.rawBody, signature, secret)) {
    return refused(401, 'UNAUTHORIZED', 'Invalid signature');
  }
  const eventName = headerValue(request.headers, 'x-github-event') ?? '';
  if (eventName === 'ping') return answer(200, { ok: true, pong: true });
  let payload: unknown;
  try {
    const contentType = headerValue(request.headers, 'content-type') ?? '';
    if (isForm(contentType)) {
      const raw = new URLSearchParams(bodyText(request.rawBody)).get('payload');
      payload = raw === null ? undefined : (JSON.parse(raw) as unknown);
    } else {
      payload = parseJson(request.rawBody);
    }
  } catch {
    return refused(400, 'VALIDATION_ERROR', 'The body is not valid JSON');
  }
  const action = stringAt(payload, 'action');
  const name = action ? `${eventName}.${action}` : eventName;
  if (spec.events && !spec.events.some((wanted) => wanted === eventName || wanted === name)) {
    return answer(202, { ignored: true, reason: `The trigger does not take ${name} events` });
  }
  if (spec.filters && !spec.filters.every((filter) => matchesGitHubFilter(payload, filter))) {
    return answer(202, { ignored: true, reason: 'The event does not match the filters' });
  }
  const delivery = headerValue(request.headers, 'x-github-delivery');
  const actor = stringAt(payload, 'sender', 'login');
  const text = gitHubText(payload);
  return {
    kind: 'event',
    event: experimental_createTriggerEvent({
      source: 'github',
      ...target,
      name,
      verified: { method: 'github', ok: true },
      ...(payload !== undefined && { payload }),
      ...(text !== undefined && { text }),
      ...(actor !== undefined && { actor }),
      ...(delivery && { dedupKey: delivery }),
    }),
  };
}

/** The mail of a provider's request, read from its usual fields */
async function defaultEmail(
  spec: EmailTriggerSpec,
  request: TriggerHttpRequest
): Promise<EmailTriggerMail> {
  const contentType = headerValue(request.headers, 'content-type') ?? '';
  if (!isForm(contentType)) {
    const body = parseJson(request.rawBody);
    if (!isRecord(body)) throw new Error('The body is not an object');
    const from =
      stringAt(body, 'FromFull', 'Email') ?? stringAt(body, 'From') ?? stringAt(body, 'from');
    const text =
      stringAt(body, 'StrippedTextReply') ||
      stringAt(body, 'TextBody') ||
      stringAt(body, 'stripped-text') ||
      stringAt(body, 'body-plain');
    const subject = stringAt(body, 'Subject') ?? stringAt(body, 'subject');
    const messageId = stringAt(body, 'MessageID') ?? stringAt(body, 'Message-Id');
    return {
      ...(from && { from }),
      ...(subject !== undefined && { subject }),
      ...(text && { text }),
      ...(messageId && { messageId }),
      fields: body,
    };
  }
  const fields = await readForm(request.rawBody, contentType);
  const text =
    fields['stripped-text'] || fields['body-plain'] || fields.text || fields.email || undefined;
  const messageId = fields['Message-Id'] ?? fields['message-id'];
  const from = fields.sender ?? fields.from;
  const subject = fields.subject ?? fields.Subject;
  const reported = spec.provider === 'sendgrid' ? fields.SPF : undefined;
  return {
    ...(from && { from }),
    ...(subject !== undefined && { subject }),
    ...(text && { text }),
    ...(messageId && { messageId }),
    ...(reported !== undefined && {
      authentication: /pass/i.test(reported) ? 'pass' : /fail/i.test(reported) ? 'fail' : 'none',
    }),
    fields,
  };
}

/** The Mailgun signature fields, from the form or the headers of a JSON request */
async function mailgunSignature(
  request: TriggerHttpRequest
): Promise<{ timestamp?: string; token?: string | Uint8Array; signature?: string }> {
  const contentType = headerValue(request.headers, 'content-type') ?? '';
  if (isForm(contentType)) {
    const fields = await readForm(request.rawBody, contentType);
    return { timestamp: fields.timestamp, token: fields.token, signature: fields.signature };
  }
  return {
    timestamp: headerValue(request.headers, 'x-mailgun-timestamp'),
    signature: headerValue(request.headers, 'x-mailgun-signature'),
    token: request.rawBody,
  };
}

/**
 * Inbound mail from a provider's webhook. Mailgun is checked by its signature (no older than
 * `maxAgeSeconds`, the signature is the delivery id against replays), Postmark and SendGrid by
 * the secret in the URL (`?token=`), in `X-Webhook-Token` or as basic auth
 */
export async function readEmail(
  spec: EmailTriggerSpec,
  request: TriggerHttpRequest,
  target: SourceTarget
): Promise<SourceOutcome> {
  let replayKey: string | undefined;
  let method: 'mailgun' | 'secret';
  if (spec.provider === 'mailgun') {
    const signingKey = resolveTriggerSecret(spec.signingKey);
    if (signingKey === undefined) {
      return refused(
        503,
        'CONFIGURATION_ERROR',
        'The Mailgun signing key of this trigger is not set'
      );
    }
    let fields: Awaited<ReturnType<typeof mailgunSignature>>;
    try {
      fields = await mailgunSignature(request);
    } catch {
      return refused(400, 'VALIDATION_ERROR', 'The body could not be read');
    }
    const { timestamp, token, signature } = fields;
    if (
      !timestamp ||
      token === undefined ||
      !verifyMailgunSignature(timestamp, token, signature, signingKey)
    ) {
      return refused(401, 'UNAUTHORIZED', 'Invalid signature');
    }
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > (spec.maxAgeSeconds ?? 300)) {
      return refused(401, 'UNAUTHORIZED', 'Stale signature');
    }
    replayKey = signature?.toLowerCase();
    method = 'mailgun';
  } else {
    if (!emailSecretMatches(spec, request)) return refused(401, 'UNAUTHORIZED', 'Unauthorized');
    method = 'secret';
  }
  let mail: EmailTriggerMail;
  try {
    mail = spec.parse ? await spec.parse(request) : await defaultEmail(spec, request);
  } catch {
    return refused(400, 'VALIDATION_ERROR', 'The mail could not be read');
  }
  const text = [
    mail.subject !== undefined && mail.subject !== '' ? `Subject: ${mail.subject}` : undefined,
    mail.text,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n\n');
  const dedupKey = mail.messageId ?? replayKey;
  return {
    kind: 'event',
    event: experimental_createTriggerEvent({
      source: 'email',
      ...target,
      name: 'email',
      verified: {
        method,
        ok: true,
        ...(mail.authentication !== undefined && { detail: mail.authentication }),
      },
      ...(mail.fields !== undefined && { payload: mail.fields }),
      ...(text !== '' && { text }),
      ...(mail.from !== undefined && { actor: mail.from }),
      ...(dedupKey !== undefined && { dedupKey }),
    }),
  };
}

function emailSecretMatches(spec: EmailTriggerSpec, request: TriggerHttpRequest): boolean {
  const token = resolveTriggerSecret(spec.token);
  if (token !== undefined) {
    const given = request.query?.token ?? headerValue(request.headers, 'x-webhook-token');
    if (given !== undefined && secretsEqual(given, token)) return true;
  }
  const basic = spec.basicAuth;
  const password = basic ? resolveTriggerSecret(basic.password) : undefined;
  const authorization = headerValue(request.headers, 'authorization');
  if (basic && password !== undefined && authorization?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf-8');
    return secretsEqual(decoded, `${basic.username}:${password}`);
  }
  return false;
}

/**
 * A callback of Slack's Events API: the signature, the URL check (`url_verification`, answered
 * with its challenge), the event type, `event_id` as the delivery id. Messages of bots, the app's
 * own among them, are ignored so a routine that answers in Slack does not wake itself
 */
export function readSlack(
  spec: SlackTriggerSpec,
  request: TriggerHttpRequest,
  target: SourceTarget
): SourceOutcome {
  const secret = resolveTriggerSecret(spec.signingSecret);
  if (secret === undefined) {
    return refused(
      503,
      'CONFIGURATION_ERROR',
      'The Slack signing secret of this trigger is not set'
    );
  }
  const check = verifySlackSignature(
    request.rawBody,
    headerValue(request.headers, 'x-slack-request-timestamp'),
    headerValue(request.headers, 'x-slack-signature'),
    secret
  );
  if (!check.ok) {
    return refused(
      401,
      'UNAUTHORIZED',
      check.reason === 'stale' ? 'Stale request' : 'Invalid signature'
    );
  }
  let body: unknown;
  try {
    body = parseJson(request.rawBody);
  } catch {
    return refused(400, 'VALIDATION_ERROR', 'The body is not valid JSON');
  }
  if (!isRecord(body)) return refused(400, 'VALIDATION_ERROR', 'The body must be an object');
  if (body.type === 'url_verification') {
    return answer(200, { challenge: typeof body.challenge === 'string' ? body.challenge : '' });
  }
  if (body.type !== 'event_callback' || !isRecord(body.event)) {
    return answer(200, { ignored: true, reason: `Slack sent ${String(body.type)}` });
  }
  const event = body.event;
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  if (event.bot_id !== undefined || event.subtype === 'bot_message') {
    return answer(200, { ignored: true, reason: 'Messages of bots are not taken' });
  }
  if (spec.events && !spec.events.includes(type)) {
    return answer(200, { ignored: true, reason: `The trigger does not take ${type} events` });
  }
  const eventId = typeof body.event_id === 'string' ? body.event_id : undefined;
  const actor = typeof event.user === 'string' ? event.user : undefined;
  const text = typeof event.text === 'string' ? event.text : undefined;
  return {
    kind: 'event',
    event: experimental_createTriggerEvent({
      source: 'slack',
      ...target,
      name: type,
      verified: { method: 'slack', ok: true },
      payload: body,
      ...(text !== undefined && { text }),
      ...(actor !== undefined && { actor }),
      ...(eventId !== undefined && { dedupKey: eventId }),
    }),
  };
}
