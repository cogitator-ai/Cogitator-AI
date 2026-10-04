import type { StageContext } from '../../runner/types.js';
import {
  ARCHIVE_DELAY_MS,
  ARCHIVE_FACT,
  ARCHIVE_QUESTION,
  LOCKER_QUESTION,
  SLOW_AGENT,
  SERVER_AGENT,
  SERVER_AGENT_DESCRIPTION,
  SERVER_AGENT_INSTRUCTIONS,
  mentionsLockerCode,
} from './agent.js';
import { networkFailure, readSse, validateAgentStream } from './sse.js';

/** How a server family answers errors; adapters on server-shared share one, Tetsu has its own. */
export interface ErrorDialect {
  /** Status of a well-formed body that fails validation. */
  invalidStatus: number;
  invalidCode: string;
  notFoundCode: string;
  /** Reads the error code out of an error body. */
  code(body: unknown): string | undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `{ error: { message, code } }`: Express, Fastify, Hono and Koa. */
export const SHARED_ERRORS: ErrorDialect = {
  invalidStatus: 400,
  invalidCode: 'INVALID_INPUT',
  notFoundCode: 'NOT_FOUND',
  code: (body) => asString(field(field(body, 'error'), 'code')),
};

/** Tetsu's envelope `{ status, message, error }` with 422 for schema failures (documented). */
export const TETSU_ERRORS: ErrorDialect = {
  invalidStatus: 422,
  invalidCode: 'VALIDATION_FAILED',
  notFoundCode: 'AGENT_NOT_FOUND',
  code: (body) => asString(field(body, 'error')),
};

export interface ServerTarget {
  label: string;
  /** Base URL including the mount path, e.g. `http://127.0.0.1:4000/cogitator`. */
  base: string;
  /** Path of the OpenAPI document under `base` (or an absolute URL), when the server serves one. */
  openapiPath?: string;
  dialect: ErrorDialect;
  /** Counts tokens of runs the gauntlet's metered backend cannot see (child processes). */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}

/** What a server answered, reduced to the parts every server should agree on. */
export interface ServerTranscript {
  label: string;
  health: { status: number; keys: string[] };
  agents: unknown;
  tools: unknown;
  run: { keys: string[]; usageKeys: string[]; toolNames: string[]; status: unknown };
  stream: { types: string[]; toolNames: string[] };
  notFound: { status: number; keys: string[] };
  malformed: { status: number };
  openapi?: { version: string; paths: number };
}

/** The run route, documented per agent (`/agents/concierge/run`) or with a parameter. */
const runPathPattern = new RegExp(`agents/(\\{name\\}|:name|${SERVER_AGENT})/run$`);

const LEAK_PATTERNS = [/\bat .+:\d+:\d+/, /node_modules/, /\/Users\/|\/home\//, /\bstack\b/i];

/** Fails when an error body carries a stack trace, a file path or the agent's instructions. */
export function assertNoLeak(body: string): void {
  const leak = LEAK_PATTERNS.find((pattern) => pattern.test(body));
  if (leak) throw new Error(`Error body leaks internals (${leak}): ${body.slice(0, 160)}`);
  if (body.includes(SERVER_AGENT_INSTRUCTIONS.slice(0, 40))) {
    throw new Error('Body exposes the agent instructions');
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function readJson(response: Response): Promise<{ raw: string; body: unknown }> {
  const raw = await response.text();
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    throw new Error(`Answer ${response.status} is not JSON: ${raw.slice(0, 120)}`);
  }
}

function expectStatus(response: Response, expected: number, raw: string): void {
  if (response.status !== expected) {
    throw new Error(`Expected ${expected}, got ${response.status}: ${raw.slice(0, 200)}`);
  }
}

function sortedKeys(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
}

function namesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(field(item, 'name')) ?? '?') : [];
}

/**
 * Sends the standard request set to one server and checks each answer: health, agent list, tool
 * list, a JSON run, an SSE run, an unknown agent, a malformed body and the OpenAPI document.
 * Returns the comparable parts for cross-server checks.
 */
export async function probeServer(
  ctx: StageContext,
  target: ServerTarget
): Promise<ServerTranscript> {
  const { label, base, dialect } = target;
  const url = (path: string) => (/^https?:/.test(path) ? path : `${base}${path}`);
  const call = (path: string, init?: RequestInit) =>
    fetch(url(path), { ...init, signal: ctx.signal });

  const health = await ctx.check(`${label}: health`, async (evidence) => {
    const response = await call('/health');
    const { raw, body } = await readJson(response);
    evidence('url', url('/health'));
    evidence('body', body);
    expectStatus(response, 200, raw);
    if (field(body, 'status') !== 'ok')
      throw new Error(`Health status is ${String(field(body, 'status'))}`);
    return { status: response.status, keys: sortedKeys(body) };
  });

  const agents = await ctx.check(`${label}: list agents`, async (evidence) => {
    const response = await call('/agents');
    const { raw, body } = await readJson(response);
    expectStatus(response, 200, raw);
    const list = field(body, 'agents');
    const agent = Array.isArray(list)
      ? list.find((item) => field(item, 'name') === SERVER_AGENT)
      : undefined;
    evidence('agents', namesOf(list));
    evidence('tools', field(agent, 'tools'));
    if (!agent) throw new Error(`Agent ${SERVER_AGENT} is not listed`);
    if (field(agent, 'description') !== SERVER_AGENT_DESCRIPTION) {
      throw new Error(`Description is ${JSON.stringify(field(agent, 'description'))}`);
    }
    const tools = field(agent, 'tools');
    if (!Array.isArray(tools) || !tools.includes('locker_code')) {
      throw new Error(`Tools are ${JSON.stringify(tools)}`);
    }
    assertNoLeak(raw);
    return body;
  });

  const tools = await ctx.check(`${label}: list tools`, async (evidence) => {
    const response = await call('/tools');
    const { raw, body } = await readJson(response);
    expectStatus(response, 200, raw);
    const list = field(body, 'tools');
    const locker = Array.isArray(list)
      ? list.find((item) => field(item, 'name') === 'locker_code')
      : undefined;
    evidence('tools', namesOf(list));
    evidence('parameters', field(locker, 'parameters'));
    const properties = field(field(locker, 'parameters'), 'properties');
    if (!locker || field(properties, 'locker') === undefined) {
      throw new Error(
        `locker_code with a JSON Schema "locker" property is missing: ${raw.slice(0, 200)}`
      );
    }
    return body;
  });

  const run = await ctx.check(`${label}: run agent (JSON)`, async (evidence) => {
    const response = await call(`/agents/${SERVER_AGENT}/run`, json({ input: LOCKER_QUESTION }));
    const { raw, body } = await readJson(response);
    expectStatus(response, 200, raw);
    const output = asString(field(body, 'output')) ?? '';
    const usage = field(body, 'usage');
    const toolNames = namesOf(field(body, 'toolCalls'));
    const inputTokens = Number(field(usage, 'inputTokens') ?? 0);
    const outputTokens = Number(field(usage, 'outputTokens') ?? 0);
    target.onUsage?.({ inputTokens, outputTokens });
    evidence('output', output.slice(0, 160));
    evidence('toolCalls', toolNames);
    evidence('threadId', field(body, 'threadId'));
    evidence('usage', usage);
    evidence('status', field(body, 'status'));
    if (!toolNames.includes('locker_code')) throw new Error('The run did not call locker_code');
    if (!mentionsLockerCode(output)) throw new Error(`The answer lacks the code: ${output}`);
    if (typeof field(body, 'threadId') !== 'string') throw new Error('The answer has no threadId');
    if (Number(field(usage, 'totalTokens') ?? 0) <= 0)
      throw new Error('The answer reports no tokens');
    if (field(body, 'checkpoint') !== undefined)
      throw new Error('The answer leaks the run checkpoint');
    return {
      keys: sortedKeys(body),
      usageKeys: sortedKeys(usage),
      toolNames: [...new Set(toolNames)],
      status: field(body, 'status'),
    };
  });

  const stream = await ctx.check(`${label}: stream agent (SSE)`, async (evidence) => {
    const response = await call(`/agents/${SERVER_AGENT}/stream`, json({ input: LOCKER_QUESTION }));
    if (response.status !== 200) {
      throw new Error(
        `Expected 200, got ${response.status}: ${(await response.text()).slice(0, 200)}`
      );
    }
    const summary = validateAgentStream(await readSse(response));
    if (summary.usage) target.onUsage?.(summary.usage);
    evidence('events', summary.events);
    evidence('types', summary.types);
    evidence('toolNames', summary.toolNames);
    evidence('text', summary.text.slice(0, 160));
    evidence('usage', summary.usage);
    if (!summary.toolNames.includes('locker_code'))
      throw new Error('No tool-call-start for locker_code');
    if (summary.toolResults === 0) throw new Error('No tool-result event');
    if (!mentionsLockerCode(summary.text))
      throw new Error(`Streamed text lacks the code: ${summary.text}`);
    if (!summary.usage || summary.usage.totalTokens <= 0)
      throw new Error('finish carries no usage');
    return {
      types: summary.types.filter((type) => !type.startsWith('reasoning')).sort(),
      toolNames: [...new Set(summary.toolNames)],
    };
  });

  const notFound = await ctx.check(`${label}: unknown agent is 404`, async (evidence) => {
    const response = await call('/agents/ghost/run', json({ input: 'hello' }));
    const { raw, body } = await readJson(response);
    evidence('status', response.status);
    evidence('body', body);
    expectStatus(response, 404, raw);
    const code = dialect.code(body);
    if (code !== dialect.notFoundCode)
      throw new Error(`Error code is ${code}, expected ${dialect.notFoundCode}`);
    assertNoLeak(raw);
    return { status: response.status, keys: sortedKeys(body) };
  });

  const malformed = await ctx.check(`${label}: malformed JSON is a 4xx`, async (evidence) => {
    const response = await call(`/agents/${SERVER_AGENT}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input": "unterminated',
    });
    const raw = await response.text();
    evidence('status', response.status);
    evidence('body', raw.slice(0, 200));
    if (response.status < 400 || response.status >= 500) {
      throw new Error(`Expected a client error, got ${response.status}: ${raw.slice(0, 200)}`);
    }
    assertNoLeak(raw);
    return { status: response.status };
  });

  const transcript: ServerTranscript = {
    label,
    health,
    agents,
    tools,
    run,
    stream,
    notFound,
    malformed,
  };

  if (target.openapiPath) {
    const path = target.openapiPath;
    transcript.openapi = await ctx.check(`${label}: OpenAPI document`, async (evidence) => {
      const response = await call(path);
      const { raw, body } = await readJson(response);
      expectStatus(response, 200, raw);
      const version = asString(field(body, 'openapi')) ?? '';
      const paths = Object.keys((field(body, 'paths') as object | undefined) ?? {});
      const runPath = paths.find((key) => runPathPattern.test(key));
      evidence('url', url(path));
      evidence('openapi', version);
      evidence('paths', paths.length);
      evidence('runPath', runPath);
      if (!version.startsWith('3.')) throw new Error(`openapi is "${version}", not 3.x`);
      if (!runPath) throw new Error(`No agent run path among ${paths.slice(0, 8).join(', ')}`);
      return { version, paths: paths.length };
    });
  }

  return transcript;
}

/**
 * An empty and a whitespace-only `input` must both be refused before the model is called, as
 * every adapter's validation promises. Runs after the comparisons, so a refusal bug does not hide
 * them.
 */
export async function checkInputValidation(ctx: StageContext, target: ServerTarget): Promise<void> {
  const { label, base, dialect } = target;
  for (const [name, input] of [
    ['empty', ''],
    ['whitespace-only', '   '],
  ] as const) {
    await ctx.check(`${label}: ${name} input is rejected`, async (evidence) => {
      const response = await fetch(`${base}/agents/${SERVER_AGENT}/run`, {
        ...json({ input }),
        signal: ctx.signal,
      });
      const { raw, body } = await readJson(response);
      evidence('status', response.status);
      evidence('body', response.ok ? 'the model was called' : body);
      if (response.ok) {
        const usage = field(body, 'usage');
        target.onUsage?.({
          inputTokens: Number(field(usage, 'inputTokens') ?? 0),
          outputTokens: Number(field(usage, 'outputTokens') ?? 0),
        });
      }
      expectStatus(response, dialect.invalidStatus, raw);
      const code = dialect.code(body);
      if (code !== dialect.invalidCode) {
        throw new Error(`Error code is ${code}, expected ${dialect.invalidCode}`);
      }
      assertNoLeak(raw);
    });
  }
}

/**
 * A run whose tool keeps the connection silent for {@link ARCHIVE_DELAY_MS} must still answer,
 * over JSON and over SSE: servers and runtimes with short idle timeouts drop it.
 */
export async function checkLongRun(ctx: StageContext, target: ServerTarget): Promise<void> {
  const { label, base } = target;
  const seconds = Math.round(ARCHIVE_DELAY_MS / 1000);
  const request = async (mode: 'run' | 'stream', started: number) => {
    try {
      return await fetch(`${base}/agents/${SLOW_AGENT}/${mode}`, {
        ...json({ input: ARCHIVE_QUESTION }),
        signal: ctx.signal,
      });
    } catch (error) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      throw new Error(`The connection dropped after ${elapsed} s: ${networkFailure(error)}`, {
        cause: error,
      });
    }
  };

  await settle([
    ctx.check(`${label}: a run silent for ${seconds} s still answers (JSON)`, async (evidence) => {
      const started = Date.now();
      const response = await request('run', started);
      const { raw, body } = await readJson(response);
      evidence('seconds', Math.round((Date.now() - started) / 1000));
      expectStatus(response, 200, raw);
      const output = asString(field(body, 'output')) ?? '';
      const usage = field(body, 'usage');
      target.onUsage?.({
        inputTokens: Number(field(usage, 'inputTokens') ?? 0),
        outputTokens: Number(field(usage, 'outputTokens') ?? 0),
      });
      evidence('output', output.slice(0, 160));
      if (!output.includes(ARCHIVE_FACT))
        throw new Error(`The answer lacks the archive fact: ${output}`);
    }),
    ctx.check(
      `${label}: a stream silent for ${seconds} s still finishes (SSE)`,
      async (evidence) => {
        const started = Date.now();
        const response = await request('stream', started);
        if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}`);
        const read = await readSse(response).finally(() =>
          evidence('seconds', Math.round((Date.now() - started) / 1000))
        );
        const summary = validateAgentStream(read);
        if (summary.usage) target.onUsage?.(summary.usage);
        evidence('types', summary.types);
        evidence('text', summary.text.slice(0, 160));
        if (!summary.text.includes(ARCHIVE_FACT))
          throw new Error(`Streamed text lacks the fact: ${summary.text}`);
      }
    ),
  ]);
}

async function settle(tasks: Promise<unknown>[]): Promise<void> {
  const failure = (await Promise.allSettled(tasks)).find(
    (outcome) => outcome.status === 'rejected'
  );
  if (failure) throw failure.reason;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which parts of two transcripts must match. */
export interface Agreement {
  /** Health keys, agent and tool listings byte for byte. */
  bodies: boolean;
  /** Keys of the JSON run answer and its usage. */
  runShape: boolean;
  /** Error envelopes and validation statuses. */
  errors: boolean;
}

/**
 * Names every way the transcripts disagree with the first one. The stream protocol (event types
 * besides reasoning, tool calls seen) and the unknown-agent status must always match.
 */
export function transcriptDifferences(
  transcripts: ServerTranscript[],
  agreement: Agreement
): string[] {
  const [reference, ...others] = transcripts;
  if (!reference) return [];
  const differences: string[] = [];
  for (const other of others) {
    const differ = (what: string, a: unknown, b: unknown) => {
      if (!same(a, b)) {
        differences.push(
          `${what}: ${reference.label}=${JSON.stringify(a)} vs ${other.label}=${JSON.stringify(b)}`
        );
      }
    };
    differ('stream event types', reference.stream.types, other.stream.types);
    differ('stream tool calls', reference.stream.toolNames, other.stream.toolNames);
    differ('unknown agent status', reference.notFound.status, other.notFound.status);
    if (agreement.bodies) {
      differ('health keys', reference.health.keys, other.health.keys);
      differ('agent list', reference.agents, other.agents);
      differ('tool list', reference.tools, other.tools);
    }
    if (agreement.runShape) {
      differ('run answer keys', reference.run.keys, other.run.keys);
      differ('run usage keys', reference.run.usageKeys, other.run.usageKeys);
      differ('run status', reference.run.status, other.run.status);
    }
    if (agreement.errors) {
      differ('unknown agent body keys', reference.notFound.keys, other.notFound.keys);
      differ('malformed JSON status', reference.malformed.status, other.malformed.status);
    }
  }
  return differences;
}
