import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  inboxItemId,
  inboxRoute,
  providerSessions,
  type BridgeAdapter,
  type BridgeHost,
  type RenderedLetter,
} from '@cogitator-ai/bridge';
import { settingsRights } from '@cogitator-ai/bridge/rights';
import { Agent, Cogitator, LocalWorkspace, experimental_Inbox, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { startFakeOllama } from '../../helpers/fake-ollama';

const FAKE_AGENT = fileURLToPath(new URL('../../../fixtures/acp/fake-agent.mjs', import.meta.url));
const MODEL = 'qwen2.5:0.5b';

let home: string;
let project: string;
let host: BridgeHost | undefined;
let errors: Error[];
let inbox: experimental_Inbox;
const clients: BridgeClient[] = [];
const closers: (() => Promise<void>)[] = [];

function scratch(prefix: string): string {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

/** The permission rules of the project, the ones the agent that hands a job over goes by. */
function projectRules(permissions: { allow?: string[]; deny?: string[] }): void {
  mkdirSync(join(project, '.claude'), { recursive: true });
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions }));
}

async function connect(caller?: { harness: string; sessionId: string }): Promise<BridgeClient> {
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home }).socket,
    ...(caller && { caller: { ...caller, cwd: project, project } }),
  });
  clients.push(client);
  return client;
}

/** A dispatcher that reads rights from the settings of the project and keeps an inbox. */
async function start(adapter: BridgeAdapter): Promise<BridgeClient> {
  host = await hostBridge({
    home,
    adapters: [adapter],
    tickMs: 50,
    rights: settingsRights({ settings: { userDirs: [], managedDirs: [] } }),
    person: inboxRoute(inbox),
    onError: (error) => errors.push(error),
  });
  return connect({ harness: 'conductor', sessionId: 'conductor-1' });
}

async function letterOf(
  client: BridgeClient,
  job: number,
  kind: RenderedLetter['kind']
): Promise<RenderedLetter> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const found = (await client.inbox({ job })).find((letter) => letter.kind === kind);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Job #${job} never got a ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** An agent of the runtime whose model calls `deploy` once, then says what came of it. */
async function deployer(): Promise<{ adapter: BridgeAdapter; deployed: string[] }> {
  const deployed: string[] = [];
  const fake = await startFakeOllama(
    (messages) => {
      const result = messages.find((message) => message.role === 'tool');
      return result
        ? { content: `The tool said: ${result.content}` }
        : { toolCalls: [{ name: 'deploy', arguments: { target: 'staging' } }] };
    },
    [MODEL]
  );
  closers.push(() => fake.close());
  const cogitator = new Cogitator({
    llm: { providers: { ollama: { baseUrl: fake.url } } },
    memory: { adapter: 'memory' },
  });
  closers.push(() => cogitator.close());
  const deploy = tool({
    name: 'deploy',
    description: 'Deploys the build to a target',
    parameters: z.object({ target: z.string() }),
    requiresApproval: true,
    execute: async ({ target }) => {
      deployed.push(target);
      return `deployed to ${target}`;
    },
  });
  const agent = new Agent({
    name: 'releaser',
    model: `ollama/${MODEL}`,
    instructions: 'You release builds.',
    tools: [deploy],
  });
  return {
    deployed,
    adapter: hostedAdapter({
      harness: 'qwen',
      open: cogitatorSessions({ runtime: cogitator, agent }),
    }),
  };
}

beforeEach(() => {
  home = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  errors = [];
  inbox = new experimental_Inbox();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await host?.close();
  host = undefined;
  for (const close of closers.splice(0).reverse()) await close();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('a call a hosted agent needs leave for', () => {
  it('is decided by the agent that handed the job over when the rules of the project allow it', async () => {
    projectRules({ allow: ['deploy'] });
    const { adapter, deployed } = await deployer();
    const conductor = await start(adapter);

    const { job } = await conductor.createJob({ to: 'qwen', body: 'Release the build' });
    const request = await letterOf(conductor, job.number, 'permission');

    expect(request.ask).toEqual({ tool: 'deploy', access: 'other' });
    expect(request.needsPerson).toBeUndefined();
    expect(request.text).toContain('[agent bridge] Yours to decide');
    expect(request.body).toContain('Call deploy with {"target":"staging"}');
    expect(deployed).toEqual([]);
    expect((await conductor.job(job.number)).state).toBe('input-required');

    await conductor.send({
      job: job.number,
      kind: 'answer',
      body: 'Staging is fine',
      verdict: 'allow',
    });
    const report = await letterOf(conductor, job.number, 'report');

    expect(deployed).toEqual(['staging']);
    expect(report).toMatchObject({
      body: 'The tool said: "deployed to staging"',
      outcome: 'completed',
    });
    expect(errors).toEqual([]);
  });

  it('is refused without anybody being asked when the rules of the project forbid it', async () => {
    projectRules({ deny: ['deploy'] });
    const { adapter, deployed } = await deployer();
    const conductor = await start(adapter);

    const { job } = await conductor.createJob({ to: 'qwen', body: 'Release the build' });
    const report = await letterOf(conductor, job.number, 'report');

    expect(deployed).toEqual([]);
    expect(report.body).toContain('The rules of conductor@');
    expect(report.body).toContain('forbid this, so it is refused');
    expect(
      (await conductor.letters({ job: job.number, kinds: ['permission'] })).map(
        (letter) => letter.state
      )
    ).toEqual(['handled']);
    expect(await inbox.list()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('waits for the person when the rules leave it open, and they answer from outside any session', async () => {
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
    const conductor = await start(
      hostedAdapter({ harness: 'gemini', open: providerSessions({ provider, root: project }) })
    );

    const { job } = await conductor.createJob({
      to: 'gemini',
      title: 'Ship it',
      body: 'Ship it; command echo pushed',
    });
    const request = await letterOf(conductor, job.number, 'permission');

    expect(request).toMatchObject({
      needsPerson: true,
      ask: { tool: 'run_command', access: 'command', command: 'echo pushed' },
    });
    expect(request.text).toContain("[agent bridge] This is the person's to allow");
    await expect(
      conductor.send({ job: job.number, kind: 'answer', body: 'Go', verdict: 'allow' })
    ).rejects.toMatchObject({ code: 'needs_person' });
    const item = await until(
      async () => (await inbox.get(inboxItemId(request.id))) ?? undefined,
      'the inbox item'
    );
    expect(item).toMatchObject({ kind: 'approval', status: 'unread' });

    const person = await connect();
    const [waiting] = await person.forPerson();
    expect(waiting.letter.id).toBe(request.id);
    await person.personAnswer({ letter: request.id, verdict: 'allow' });
    const report = await letterOf(conductor, job.number, 'report');

    expect(report).toMatchObject({ body: 'ran:pushed', outcome: 'completed' });
    await until(
      async () =>
        (await inbox.get(inboxItemId(request.id)))?.status === 'archived' ? true : undefined,
      'the item of the request to be put away'
    );
    expect(errors).toEqual([]);
  });
});
