import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type { ChatRequest, ChatResponse, ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { UsageError } from '../utils/cli';
import {
  HEADLESS_EXIT,
  claimStdout,
  exitCodeOfTurn,
  headlessPlan,
  parseInputLine,
  readJsonSchema,
  resultLine,
  sessionsDbPath,
  streamJsonEvent,
  withSessionStore,
  type HeadlessPlan,
} from '../utils/headless';
import { runHeadless, serialQueue } from '../commands/headless';

const USAGE = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

type Turn = ChatResponse | ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);

function answer(content: string): ChatResponse {
  return { id: 'r', content, finishReason: 'stop', usage: USAGE };
}

function scripted(turns: Turn[]) {
  const requests: ChatRequest[] = [];
  let next = 0;
  const take = async (request: ChatRequest) => {
    requests.push({ ...request, messages: [...request.messages] });
    const turn = turns[Math.min(next++, turns.length - 1)]!;
    return typeof turn === 'function' ? turn(request) : turn;
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: take,
    async *chatStream(request): AsyncGenerator<ChatStreamChunk> {
      const response = await take(request);
      if (response.content) yield { id: 's', delta: { content: response.content } };
      yield {
        id: 's',
        delta: response.toolCalls ? { toolCalls: response.toolCalls } : {},
        finishReason: response.finishReason,
        usage: response.usage,
      };
    },
  };
  return { backend, requests };
}

function lines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const user = (content: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } });

function plan(overrides: Partial<HeadlessPlan> = {}): HeadlessPlan {
  return {
    outputFormat: 'text',
    inputFormat: 'text',
    fork: false,
    persistSessions: false,
    ...overrides,
  };
}

async function headless(options: {
  turns: Turn[];
  plan: HeadlessPlan;
  message?: string;
  stdin?: string[];
  cogitator?: Cogitator;
}) {
  const { backend, requests } = scripted(options.turns);
  const cogitator =
    options.cogitator ??
    new Cogitator({ memory: { adapter: 'memory' }, llm: { backends: { mock: backend } } });
  const deploy = tool({
    name: 'deploy',
    description: 'Deploys',
    parameters: z.object({ target: z.string() }),
    requiresApproval: true,
    execute: async ({ target }) => `deployed ${target}`,
  });
  const agent = new Agent({ name: 'cli', model: 'mock/m', instructions: 'x', tools: [deploy] });
  const out = new PassThrough();
  let stdoutText = '';
  out.on('data', (chunk: Buffer) => (stdoutText += chunk.toString()));
  let stderrText = '';
  const stdin = new PassThrough();
  for (const line of options.stdin ?? []) stdin.write(`${line}\n`);
  stdin.end();
  const stdout = claimStdout(out, { write: (text: string) => (stderrText += text) });
  try {
    const code = await runHeadless({
      cogitator,
      agent,
      plan: options.plan,
      ...(options.message !== undefined && { message: options.message }),
      io: {
        stdout,
        stderr: { write: (text: string) => (stderrText += text) },
        stdin,
        stdinIsTTY: false,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    return { code, stdout: stdoutText, stderr: stderrText, requests, cogitator };
  } finally {
    stdout.restore();
  }
}

describe('headlessPlan', () => {
  it('is undefined without -p and refuses headless flags without it', () => {
    expect(headlessPlan({})).toBeUndefined();
    for (const flags of [
      { outputFormat: 'json' },
      { resume: 'x' },
      { fork: true },
      { jsonSchema: '{}' },
      { sessionPersistence: false },
    ]) {
      expect(() => headlessPlan(flags)).toThrow(UsageError);
    }
  });

  it('checks the flags that go together', () => {
    expect(() => headlessPlan({ print: true, interactive: true })).toThrow(UsageError);
    expect(() => headlessPlan({ print: true, outputFormat: 'xml' })).toThrow(/output-format/);
    expect(() => headlessPlan({ print: true, inputFormat: 'stream-json' })).toThrow(
      /needs --output-format stream-json/
    );
    expect(() => headlessPlan({ print: true, fork: true })).toThrow(/--resume/);
    expect(() => headlessPlan({ print: true, resume: 'a', sessionPersistence: false })).toThrow(
      /--no-session-persistence/
    );
    expect(() => headlessPlan({ print: true, resume: 'a', sessionId: 'b' })).toThrow(/--fork/);
    expect(headlessPlan({ print: true, resume: 'a', sessionId: 'b', fork: true })).toMatchObject({
      resume: 'a',
      sessionId: 'b',
      fork: true,
      persistSessions: true,
      outputFormat: 'text',
    });
    try {
      headlessPlan({ print: true, outputFormat: 'xml' });
    } catch (error) {
      expect((error as UsageError).exitCode).toBe(2);
    }
  });
});

describe('readJsonSchema', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-schema-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads inline JSON and files', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(readJsonSchema(JSON.stringify(schema))).toEqual(schema);
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema));
    expect(readJsonSchema('schema.json', dir)).toEqual(schema);
  });

  it('refuses what is not a schema object', () => {
    expect(() => readJsonSchema('{nope', dir)).toThrow(/not valid JSON/);
    expect(() => readJsonSchema('missing.json', dir)).toThrow(/neither inline JSON nor a file/);
    writeFileSync(join(dir, 'list.json'), '[1]');
    expect(() => readJsonSchema('list.json', dir)).toThrow(/object/);
  });
});

describe('parseInputLine', () => {
  it('reads user lines with text, parts and delivery', () => {
    expect(parseInputLine({ type: 'user', message: { role: 'user', content: 'hi' } })).toEqual({
      line: { type: 'user', input: [{ type: 'text', text: 'hi' }] },
    });
    expect(
      parseInputLine({
        type: 'user',
        delivery: 'followUp',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        },
      })
    ).toEqual({
      line: {
        type: 'user',
        delivery: 'followUp',
        input: [
          { type: 'text', text: 'see' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
        ],
      },
    });
  });

  it('reads resume and interrupt lines and refuses others', () => {
    expect(parseInputLine({ type: 'resume', defaultDecision: { approved: true } })).toEqual({
      line: { type: 'resume', defaultDecision: { approved: true } },
    });
    expect(parseInputLine({ type: 'interrupt' })).toEqual({ line: { type: 'interrupt' } });
    expect(parseInputLine({ type: 'user', message: { role: 'user', content: '' } })).toHaveProperty(
      'error'
    );
    expect(parseInputLine({ type: 'assistant' })).toHaveProperty('error');
    expect(parseInputLine('hi')).toHaveProperty('error');
  });
});

describe('headless helpers', () => {
  it('maps turns to exit codes', () => {
    expect(exitCodeOfTurn({ status: 'completed' })).toBe(0);
    expect(exitCodeOfTurn({ status: 'completed' }, true)).toBe(1);
    expect(exitCodeOfTurn({ status: 'failed' })).toBe(1);
    expect(exitCodeOfTurn({ status: 'interrupted' })).toBe(1);
    expect(exitCodeOfTurn({ status: 'paused' })).toBe(HEADLESS_EXIT.paused);
  });

  it('tags stream events with the session and the parent tool call', () => {
    expect(
      streamJsonEvent({
        threadId: 't',
        turnId: 'u',
        event: { type: 'text-delta', id: 'p', delta: 'x' },
      })
    ).toEqual({
      type: 'text-delta',
      id: 'p',
      delta: 'x',
      session_id: 't',
      parent_tool_use_id: null,
    });
    expect(
      streamJsonEvent({
        threadId: 't',
        turnId: 'u',
        event: { type: 'text-end', id: 'p' },
        parentToolCallId: 'c1',
      }).parent_tool_use_id
    ).toBe('c1');
  });

  it('marks a missing structured answer as an error result', () => {
    const turn = {
      id: 'u',
      threadId: 't',
      status: 'completed' as const,
      output: 'not json',
      structuredError: 'bad',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
    };
    expect(resultLine(turn, { structuredWanted: true })).toMatchObject({
      subtype: 'error',
      is_error: true,
      duration_ms: 10,
      error: { message: 'bad', code: 'STRUCTURED_OUTPUT_MISSING' },
    });
    expect(resultLine(turn)).toMatchObject({ subtype: 'success', result: 'not json' });
  });

  it('keeps sessions in SQLite by default, as configured otherwise', () => {
    expect(sessionsDbPath({ COGITATOR_SESSIONS_DB: '/tmp/x.db' })).toBe('/tmp/x.db');
    expect(sessionsDbPath({})).toMatch(/\.cogitator\/sessions\.db$/);
    expect(withSessionStore({}, true, { COGITATOR_SESSIONS_DB: '/tmp/s.db' }).memory).toEqual({
      adapter: 'sqlite',
      sqlite: { path: '/tmp/s.db' },
    });
    expect(withSessionStore({}, false).memory).toEqual({ adapter: 'memory' });
    const configured = { memory: { adapter: 'redis' as const } };
    expect(withSessionStore(configured, true)).toBe(configured);
    expect(withSessionStore(configured, false).memory).toEqual({ adapter: 'memory' });
  });

  it('sends console output to stderr while stdout is claimed', async () => {
    const out = new PassThrough();
    let stdout = '';
    out.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    let stderr = '';
    const original = console.log;
    const claimed = claimStdout(out, { write: (text: string) => (stderr += text) });
    console.log('log line %d', 1);
    console.info('info line');
    await claimed.write('protocol\n');
    await claimed.drained();
    claimed.restore();
    expect(console.log).toBe(original);
    expect(stdout).toBe('protocol\n');
    expect(stderr).toBe('log line 1\ninfo line\n');
  });
});

describe('runHeadless', () => {
  it('prints the answer as text and exits 0', async () => {
    const run = await headless({ turns: [answer('pong')], plan: plan(), message: 'ping' });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('pong\n');
  });

  it('reads the prompt from stdin', async () => {
    const run = await headless({ turns: [answer('ok')], plan: plan(), stdin: ['review this'] });
    expect(run.stdout).toBe('ok\n');
    const last = run.requests.at(-1)?.messages.at(-1);
    expect(last?.content).toBe('review this');
  });

  it('puts what is piped on stdin after the prompt argument', async () => {
    const run = await headless({
      turns: [answer('reviewed')],
      plan: plan(),
      message: 'Review this',
      stdin: ['diff --git a/x b/x', '+added'],
    });
    expect(run.stdout).toBe('reviewed\n');
    const last = run.requests.at(-1)?.messages.at(-1);
    expect(last?.content).toBe('Review this\n\ndiff --git a/x b/x\n+added');
  });

  it('answers one JSON result with the structured answer', async () => {
    const run = await headless({
      turns: [answer('{"n":3}')],
      plan: plan({
        outputFormat: 'json',
        outputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      }),
      message: 'count',
    });
    expect(run.code).toBe(0);
    const [result] = lines(run.stdout);
    expect(result).toMatchObject({
      type: 'result',
      subtype: 'success',
      structured_output: { n: 3 },
      session_id: expect.any(String),
    });
  });

  it('exits 3 for a paused turn and 1 for a failed one', async () => {
    const paused = await headless({
      turns: [
        {
          id: 'r',
          content: '',
          toolCalls: [{ id: 'c1', name: 'deploy', arguments: { target: 'prod' } }],
          finishReason: 'tool_calls',
          usage: USAGE,
        },
      ],
      plan: plan({ outputFormat: 'json' }),
      message: 'ship',
    });
    expect(paused.code).toBe(3);
    expect(lines(paused.stdout)[0]).toMatchObject({
      subtype: 'paused',
      pending_approvals: [expect.objectContaining({ toolCallId: 'c1' })],
    });

    const failed = await headless({
      turns: [
        () => {
          throw new Error('model down');
        },
      ],
      plan: plan(),
      message: 'x',
      cogitator: new Cogitator({
        memory: { adapter: 'memory' },
        llm: {
          backends: {
            mock: scripted([
              () => {
                throw new Error('model down');
              },
            ]).backend,
          },
          retry: { maxRetries: 0 },
        },
      }),
    });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('model down');
  });

  it('runs stream-json turns, tagging every line and ending each with a result', async () => {
    const run = await headless({
      turns: [answer('first'), answer('second')],
      plan: plan({ outputFormat: 'stream-json', inputFormat: 'stream-json', sessionId: 'sj' }),
      stdin: [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } }),
        'not json',
        JSON.stringify({ type: 'bogus' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } }),
      ],
    });
    expect(run.code).toBe(0);
    const out = lines(run.stdout);
    expect(out.every((line) => line.session_id === 'sj')).toBe(true);
    const results = out.filter((line) => line.type === 'result');
    expect(results.map((line) => line.result)).toEqual(['first', 'second']);
    expect(
      out.filter((line) => line.type !== 'result').every((l) => l.parent_tool_use_id === null)
    ).toBe(true);
    expect(run.stderr).toContain('Skipped input line 2');
    expect(run.stderr).toContain('Skipped an input line');
  });

  it('applies an interrupt that comes while the turn is starting', async () => {
    const run = await headless({
      turns: [
        (request) =>
          new Promise<ChatResponse>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ],
      plan: plan({ outputFormat: 'stream-json', inputFormat: 'stream-json' }),
      stdin: [user('go on forever'), JSON.stringify({ type: 'interrupt' })],
    });
    const results = lines(run.stdout).filter((line) => line.type === 'result');
    expect(results.map((line) => line.subtype)).toEqual(['interrupted']);
    expect(run.stderr).not.toContain('Nothing to interrupt');
    expect(run.code).toBe(1);
  });

  it('delivers a user line that comes while the turn is starting to that turn', async () => {
    const run = await headless({
      turns: [answer('first'), answer('with more')],
      plan: plan({ outputFormat: 'stream-json', inputFormat: 'stream-json' }),
      stdin: [
        user('one'),
        JSON.stringify({
          type: 'user',
          delivery: 'followUp',
          message: { role: 'user', content: 'more' },
        }),
      ],
    });
    const results = lines(run.stdout).filter((line) => line.type === 'result');
    expect(results).toHaveLength(1);
    const sent = run.requests
      .at(-1)
      ?.messages.filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(sent).toEqual(['one', 'more']);
  });

  it('resumes a paused turn from a resume line', async () => {
    const run = await headless({
      turns: [
        {
          id: 'r',
          content: '',
          toolCalls: [{ id: 'c1', name: 'deploy', arguments: { target: 'eu' } }],
          finishReason: 'tool_calls',
          usage: USAGE,
        },
        answer('shipped'),
      ],
      plan: plan({ outputFormat: 'stream-json', inputFormat: 'stream-json' }),
      stdin: [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship' } }),
        JSON.stringify({ type: 'resume', decisions: { c1: { approved: true } } }),
      ],
    });
    const results = lines(run.stdout).filter((line) => line.type === 'result');
    expect(results.map((line) => line.subtype)).toEqual(['paused', 'success']);
    expect(run.code).toBe(0);
  });

  it('answers input to a paused session with an error result', async () => {
    const run = await headless({
      turns: [
        {
          id: 'r',
          content: '',
          toolCalls: [{ id: 'c1', name: 'deploy', arguments: { target: 'eu' } }],
          finishReason: 'tool_calls',
          usage: USAGE,
        },
      ],
      plan: plan({ outputFormat: 'stream-json', inputFormat: 'stream-json' }),
      stdin: [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship' } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'and?' } }),
      ],
    });
    const results = lines(run.stdout).filter((line) => line.type === 'result');
    expect(results.at(-1)).toMatchObject({ subtype: 'error', error: { code: '-32022' } });
    expect(run.code).toBe(1);
  });

  it('continues and forks a session of the same store', async () => {
    const { backend, requests } = scripted([answer('a1'), answer('a2'), answer('a3')]);
    const cogitator = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: backend } },
    });
    await headless({ turns: [], plan: plan({ sessionId: 'base' }), message: 'q1', cogitator });
    const resumed = await headless({
      turns: [],
      plan: plan({ resume: 'base' }),
      message: 'q2',
      cogitator,
    });
    expect(resumed.stdout).toBe('a2\n');
    const forked = await headless({
      turns: [],
      plan: plan({ resume: 'base', fork: true, sessionId: 'branch', outputFormat: 'json' }),
      message: 'q3',
      cogitator,
    });
    expect(lines(forked.stdout)[0]).toMatchObject({ session_id: 'branch', result: 'a3' });
    const sent = requests
      .at(-1)
      ?.messages.filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(sent).toEqual(['q1', 'q2', 'q3']);
    await expect(
      headless({ turns: [], plan: plan({ resume: 'ghost' }), message: 'x', cogitator })
    ).rejects.toThrow('Session ghost does not exist');
    await expect(
      headless({ turns: [], plan: plan({ sessionId: 'base' }), message: 'x', cogitator })
    ).rejects.toThrow(/exists already/);
  });
});

describe('serialQueue', () => {
  it('runs an item pushed while the last run is ending, at any point of that ending', async () => {
    for (let depth = 0; depth < 8; depth++) {
      const done: string[] = [];
      const queue = serialQueue<string>(async (item) => {
        done.push(item);
        if (item !== 'first') return;
        let tick: Promise<void> = Promise.resolve();
        for (let i = 0; i < depth; i++) tick = tick.then(() => undefined);
        void tick.then(() => queue.push('second'));
      });
      queue.push('first');
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await queue.drain();
      expect(done, `depth ${depth}`).toEqual(['first', 'second']);
    }
  });

  it('keeps order and runs one item at a time', async () => {
    const order: string[] = [];
    let running = 0;
    const queue = serialQueue<number>(async (n) => {
      running++;
      expect(running).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(String(n));
      running--;
    });
    for (const n of [1, 2, 3]) queue.push(n);
    await queue.drain();
    expect(order).toEqual(['1', '2', '3']);
  });
});
