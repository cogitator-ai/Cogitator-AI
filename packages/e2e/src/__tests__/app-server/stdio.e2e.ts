import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  APP_SERVER_ERROR_CODES,
  APP_SERVER_PROTOCOL_VERSION,
  AppServerClient,
  AppServerClientError,
  type Turn,
  type TurnEventNotification,
} from '@cogitator-ai/app-server/client';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';
import { getOllamaUrl, getTestModel, ollamaSkipReason } from '../../helpers/setup';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.tmp-app-server-e2e', import.meta.url));

interface Served {
  client: AppServerClient;
  child: ChildProcessWithoutNullStreams;
  stdoutLines: string[];
  stderr: () => string;
  exited: Promise<number | null>;
  completed(turnId: string): Promise<Turn>;
  events: TurnEventNotification[];
}

function serve(args: string[], cwd: string, env: NodeJS.ProcessEnv): Served {
  const child = spawn(process.execPath, [CLI, 'app-server', ...args], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
  });
  const stdoutLines: string[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const lines = createInterface({ input: child.stdout });
  const listeners: Array<(line: string) => void> = [];
  lines.on('line', (line) => {
    stdoutLines.push(line);
    for (const listener of listeners) listener(line);
  });
  const client = new AppServerClient({
    send: (line) => child.stdin.write(`${line}\n`),
    onLine: (callback) => listeners.push(callback),
    close: () => child.stdin.end(),
  });
  const done = new Map<string, Turn>();
  client.on('turn/completed', ({ turn }) => done.set(turn.id, turn));
  const events: TurnEventNotification[] = [];
  client.on('turn/event', (event) => events.push(event));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    client,
    child,
    stdoutLines,
    stderr: () => stderr,
    exited,
    events,
    async completed(turnId) {
      const deadline = Date.now() + 90_000;
      while (!done.has(turnId)) {
        if (Date.now() > deadline) throw new Error(`turn ${turnId} did not complete: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return done.get(turnId)!;
    },
  };
}

async function initialize(client: AppServerClient) {
  return client.initialize({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    clientInfo: { name: 'e2e', version: '1' },
  });
}

describe('cogitator app-server over stdio (fake Ollama)', () => {
  let ollama: FakeOllama;
  let workDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    ollama = await startFakeOllama(
      (messages) => {
        const last = messages.at(-1)?.content ?? '';
        if (last.includes('Review')) {
          return {
            content: JSON.stringify({
              findings: [
                {
                  title: 'Unchecked input',
                  body: 'The handler trusts the body.',
                  priority: 1,
                  confidence: 0.7,
                },
              ],
              overallCorrectness: 'incorrect',
              overallExplanation: 'One problem.',
            }),
          };
        }
        return { content: `echo: ${last}` };
      },
      ['fake-model']
    );
  });

  afterAll(async () => {
    await ollama.close();
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(SCRATCH_ROOT, 'run-'));
    env = {
      OLLAMA_URL: ollama.url,
      OLLAMA_HOST: '',
      OLLAMA_API_KEY: '',
      COGITATOR_MODEL: '',
      COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
    };
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('initializes, runs a turn and keeps stdout to protocol lines', async () => {
    const served = serve(['-m', 'ollama/fake-model'], workDir, env);
    const early = await served.client.threadList().catch((error: unknown) => error);
    expect(early).toBeInstanceOf(AppServerClientError);
    expect((early as AppServerClientError).code).toBe(APP_SERVER_ERROR_CODES.notInitialized);

    const init = await initialize(served.client);
    expect(init.agents).toEqual([{ name: 'default', model: 'ollama/fake-model', default: true }]);
    const { thread } = await served.client.threadStart({ threadId: 'e2e-thread' });
    const { turn } = await served.client.turnStart({
      threadId: thread.id,
      input: [{ type: 'text', text: 'hello there' }],
    });
    const done = await served.completed(turn.id);
    expect(done.status).toBe('completed');
    expect(done.output).toBe('echo: hello there');
    expect(served.events.map((event) => event.event.type)).toContain('text-delta');

    const listed = await served.client.threadList();
    expect(listed.threads.map((t) => t.id)).toContain('e2e-thread');
    served.client.close();
    expect(await served.exited).toBe(0);
    for (const line of served.stdoutLines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  it('keeps threads across processes in the sessions database', async () => {
    const first = serve(['-m', 'ollama/fake-model'], workDir, env);
    await initialize(first.client);
    await first.client.threadStart({ threadId: 'kept' });
    const { turn } = await first.client.turnStart({
      threadId: 'kept',
      input: [{ type: 'text', text: 'remember me' }],
    });
    await first.completed(turn.id);
    first.client.close();
    await first.exited;

    const second = serve(['-m', 'ollama/fake-model'], workDir, env);
    await initialize(second.client);
    const resumed = await second.client.threadResume({ threadId: 'kept' });
    expect(resumed.messages.map((m) => m.text)).toEqual(['remember me', 'echo: remember me']);
    const fork = await second.client.threadFork({ threadId: 'kept', newThreadId: 'kept-fork' });
    expect(fork.thread.forkedFrom).toBe('kept');
    second.client.close();
    await second.exited;
  });

  it('reviews a custom target into a review thread', async () => {
    const served = serve(['-m', 'ollama/fake-model'], workDir, env);
    await initialize(served.client);
    const { thread } = await served.client.threadStart();
    const review = await served.client.reviewStart({
      threadId: thread.id,
      target: { type: 'custom', instructions: 'Review the request handler for input checks' },
    });
    const done = await served.completed(review.turn.id);
    expect(done.review?.overallCorrectness).toBe('incorrect');
    expect(done.review?.findings[0]?.title).toBe('Unchecked input');
    served.client.close();
    await served.exited;
  });

  it('writes the typed client and the JSON Schema', () => {
    const outDir = join(workDir, 'gen');
    for (const sub of ['generate-ts', 'generate-json-schema']) {
      const result = spawnSync(process.execPath, [CLI, 'app-server', sub, '--out', outDir], {
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
    }
    const ts = readFileSync(join(outDir, 'cogitator-app-server.ts'), 'utf-8');
    expect(ts).toContain('export class AppServerClient');
    const schema = JSON.parse(
      readFileSync(join(outDir, 'cogitator-app-server.schema.json'), 'utf-8')
    ) as { 'x-methods': Record<string, unknown> };
    expect(Object.keys(schema['x-methods'])).toContain('turn/start');
  });
});

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

describeOllama('cogitator app-server over stdio (Ollama)', () => {
  let workDir: string;

  beforeAll(() => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    workDir = mkdtempSync(join(SCRATCH_ROOT, 'ollama-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs a turn on a real model', async () => {
    const served = serve(['-m', `ollama/${getTestModel()}`], workDir, {
      OLLAMA_URL: getOllamaUrl(),
      OLLAMA_HOST: '',
      OLLAMA_API_KEY: '',
      COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
    });
    await initialize(served.client);
    const { thread } = await served.client.threadStart();
    const { turn } = await served.client.turnStart({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Reply with one word: pong' }],
    });
    const done = await served.completed(turn.id);
    expect(done.status).toBe('completed');
    expect(done.output?.trim().length).toBeGreaterThan(0);
    expect(done.usage?.totalTokens).toBeGreaterThan(0);
    served.client.close();
    expect(await served.exited).toBe(0);
  });
});
