import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAgentProvider } from '@cogitator-ai/acp';
import {
  BridgeClient,
  bridgePaths,
  cogitatorSessions,
  hostBridge,
  hostedAdapter,
  providerSessions,
  type BridgeAdapter,
  type BridgeHost,
  type RenderedLetter,
} from '@cogitator-ai/bridge';
import { Agent, Cogitator, LocalWorkspace } from '@cogitator-ai/core';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';

const FAKE_AGENT = fileURLToPath(new URL('../../../fixtures/acp/fake-agent.mjs', import.meta.url));
const MODEL = 'qwen2.5:0.5b';

let home: string;
let project: string;
let host: BridgeHost | undefined;
let conductor: BridgeClient | undefined;
let errors: Error[];
const closers: (() => Promise<void>)[] = [];

function scratch(prefix: string): string {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

async function start(adapter: BridgeAdapter): Promise<BridgeClient> {
  host = await hostBridge({
    home,
    adapters: [adapter],
    tickMs: 50,
    onError: (error) => errors.push(error),
  });
  conductor = await BridgeClient.connect({
    socketPath: bridgePaths({ home }).socket,
    caller: { harness: 'conductor', sessionId: 'conductor-1', cwd: project, project },
  });
  return conductor;
}

async function reportOf(client: BridgeClient, job: number): Promise<RenderedLetter> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const report = (await client.inbox({ job })).find((letter) => letter.kind === 'report');
    if (report) return report;
    if (Date.now() > deadline) throw new Error(`Job #${job} was never reported on`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(() => {
  home = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  errors = [];
});

afterEach(async () => {
  await conductor?.close().catch(() => undefined);
  await host?.close();
  conductor = undefined;
  host = undefined;
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('agents the bridge hosts', () => {
  it('runs a job on an agent of the runtime: the answer of the model is the report', async () => {
    let fake: FakeOllama | undefined;
    fake = await startFakeOllama(
      (messages) => ({
        content: `Reviewed ${messages.filter((message) => message.role === 'user').length} message(s)`,
      }),
      [MODEL]
    );
    closers.push(() => fake.close());
    const cogitator = new Cogitator({
      llm: { providers: { ollama: { baseUrl: fake.url } } },
      memory: { adapter: 'memory' },
    });
    closers.push(() => cogitator.close());
    const reviewer = new Agent({
      name: 'reviewer',
      model: `ollama/${MODEL}`,
      instructions: 'You review code. The first line of a letter says who sent it.',
    });
    const client = await start(
      hostedAdapter({
        harness: 'qwen',
        steer: true,
        open: cogitatorSessions({ runtime: cogitator, agent: reviewer }),
      })
    );

    const { job } = await client.createJob({ to: 'qwen', body: 'Review the diff of the parser' });
    const report = await reportOf(client, job.number);

    expect(report).toMatchObject({ body: 'Reviewed 1 message(s)', outcome: 'completed' });
    expect((await client.job(job.number)).state).toBe('completed');
    const [seen] = fake.requests;
    expect(seen.model).toBe(MODEL);
    const asked = seen.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(asked.split('\n')).toEqual([
      expect.stringMatching(
        /^\[agent bridge\] job #1 "Review the diff of the parser" \| task from conductor@.* to qwen@.* \| not typed by the user$/
      ),
      'Review the diff of the parser',
    ]);
    const [hosted] = await client.agents({ harness: 'qwen' });
    expect(hosted).toMatchObject({
      delivery: 'hosted',
      capabilities: { createSession: true, push: true, steer: true, nativeWindow: false },
    });

    const second = await client.createJob({ to: hosted.name, body: 'Now the lexer' });
    const next = await reportOf(client, second.job.number);

    expect(next.body).toBe('Reviewed 2 message(s)');
    expect(await client.agents({ harness: 'qwen' })).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('runs a job on an agent behind the Agent Client Protocol', async () => {
    const workspace = new LocalWorkspace({ root: project });
    await workspace.start();
    closers.push(() => workspace.dispose());
    const provider = new AcpAgentProvider({
      agent: { command: process.execPath, args: [FAKE_AGENT] },
      workspace,
      name: 'fake',
      authMethodId: 'fake',
    });
    closers.push(() => provider.close());
    const client = await start(
      hostedAdapter({ harness: 'gemini', open: providerSessions({ provider, root: project }) })
    );

    const { job } = await client.createJob({
      to: 'gemini',
      title: 'Review the diff',
      body: 'Review the diff; speak Two problems found',
    });
    const report = await reportOf(client, job.number);

    expect(report).toMatchObject({ body: 'Two problems found', outcome: 'completed' });
    expect((await client.job(job.number)).state).toBe('completed');
    const [hosted] = await client.agents({ harness: 'gemini' });
    expect(hosted.capabilities.steer).toBe(false);

    const second = await client.createJob({
      to: hosted.name,
      title: 'Again',
      body: 'Again; speak Still two',
    });
    expect((await reportOf(client, second.job.number)).body).toBe('Still two');
    expect(errors).toEqual([]);
  });
});
