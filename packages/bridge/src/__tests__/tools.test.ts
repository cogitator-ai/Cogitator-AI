import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@cogitator-ai/types';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { bridgePaths, canonicalPath } from '../paths';
import { TOOL_CALL_HINT_KEY } from '../tools/caller';
import { BRIDGE_INSTRUCTIONS } from '../tools/guidance';
import { bridgeTools } from '../tools/tools';
import { FakeAdapter } from './bridge-kit';
import { socketDir, tempDir } from './helpers';

let home: string;
let removeHome: () => void;
let project: string;
let removeProject: () => void;
const hosts: BridgeHost[] = [];
const errors: Error[] = [];

async function startHost(options: Parameters<typeof hostBridge>[0] = {}): Promise<BridgeHost> {
  const host = await hostBridge({
    home,
    tickMs: 25,
    onError: (error) => errors.push(error),
    ...options,
  });
  hosts.push(host);
  return host;
}

beforeEach(() => {
  ({ dir: home, remove: removeHome } = socketDir());
  const made = tempDir('cogitator-bridge-tools-');
  project = canonicalPath(made.dir);
  removeProject = made.remove;
  mkdirSync(join(project, '.git'));
  errors.length = 0;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  removeHome();
  removeProject();
  expect(errors).toEqual([]);
});

/** What a harness adds to a call: nothing, the hint of a hook, or what Codex sends with it. */
interface Origin {
  hint?: { harness: string; session: string; cwd?: string };
  meta?: Record<string, unknown>;
  client?: string;
}

interface Session {
  call(name: string, args?: Record<string, unknown>, origin?: Origin): Promise<string>;
}

/** The tools as one server process gives them to the session it was started for. */
function session(env: NodeJS.ProcessEnv, base: Origin = {}): Session {
  const tools = bridgeTools({ socketPath: bridgePaths({ home }).socket, env, cwd: project });
  return {
    async call(name, args = {}, origin = base) {
      const found = tools.find((candidate) => candidate.name === name) as Tool | undefined;
      if (!found) throw new Error(`No tool ${name}`);
      const withHint = origin.hint ? { ...args, [TOOL_CALL_HINT_KEY]: origin.hint } : args;
      const parsed = (found.parameters as { parse(value: unknown): unknown }).parse(withHint);
      const context = {
        agentId: 'test',
        runId: 'run',
        signal: new AbortController().signal,
        request: {
          ...(origin.meta && { meta: origin.meta }),
          ...(origin.client && { client: { name: origin.client } }),
        },
      };
      return String(await found.execute(parsed as never, context as never));
    },
  };
}

const claude = (id = 'session-claude'): Session => session({ CLAUDE_CODE_SESSION_ID: id });

const codex = (thread = 'thread-codex'): Session =>
  session(
    {},
    { meta: { 'x-codex-turn-metadata': { thread_id: thread } }, client: 'codex-mcp-client' }
  );

function jobNumber(text: string): number {
  const match = /Job #(\d+)/.exec(text);
  if (!match) throw new Error(`No job number in: ${text}`);
  return Number(match[1]);
}

describe('bridgeTools', () => {
  it('are the ten tools of the bridge, each saying what it does to the world', () => {
    const tools = bridgeTools({ socketPath: bridgePaths({ home }).socket });

    expect(tools.map((tool) => tool.name)).toEqual([
      'delegate',
      'ask',
      'answer',
      'report',
      'note',
      'inbox',
      'job',
      'jobs',
      'cancel',
      'agents',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(
        tool.annotations?.readOnlyHint === true || tool.annotations?.destructiveHint === false
      ).toBe(true);
      expect(JSON.stringify(tool.toJSON())).not.toContain(TOOL_CALL_HINT_KEY);
    }
    expect(BRIDGE_INSTRUCTIONS).toContain('end your turn');
  });

  it('carry a job from one session to another and back', async () => {
    const adapter = new FakeAdapter({ harness: 'codex' });
    await startHost({ adapters: [adapter] });
    const orchestrator = claude();
    const worker = codex();
    expect(await worker.call('inbox')).toBe('No letters wait for this session.');

    const handed = await orchestrator.call('delegate', {
      to: 'codex',
      task: 'Write the tests for the rate limiter\nCover the burst case',
    });
    const job = jobNumber(handed);
    expect(handed).toContain(`Job #${job} is with codex@`);
    expect(handed).toContain('end your turn');
    expect(adapter.texts[0]).toContain('Write the tests for the rate limiter');

    const asked = await worker.call('ask', { job, question: 'Mock Redis or run a real one?' });
    expect(asked).toContain('Asked claude@');
    expect(asked).toContain('input-required');

    const mail = await orchestrator.call('inbox');
    expect(mail).toContain('[agent bridge]');
    expect(mail).toContain('Mock Redis or run a real one?');

    expect(await orchestrator.call('answer', { job, answer: 'Mock it' })).toMatch(
      /Answered codex@.+ is working/
    );
    expect(await worker.call('note', { job, text: 'Half of the cases are in' })).toContain(
      'Sent the note to claude@'
    );
    expect(
      await worker.call('report', { job, result: '14 tests in limiter.test.ts, all pass' })
    ).toMatch(/Reported to claude@.+ is completed/);

    const seen = await orchestrator.call('job', { job });
    expect(seen).toContain(`#${job} completed`);
    expect(seen).toContain('report (completed) from codex@');
    expect(seen).toContain('14 tests in limiter.test.ts, all pass');
    expect(await orchestrator.call('jobs')).toBe('This session has no jobs in progress.');
    expect(await orchestrator.call('jobs', { all: true })).toContain(`#${job} completed`);
  });

  it('report a job that failed as failed', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    const worker = codex();
    await worker.call('inbox');
    const job = jobNumber(await claude().call('delegate', { to: 'codex', task: 'Fix the build' }));

    expect(
      await worker.call('report', { job, result: 'The toolchain is missing', failed: true })
    ).toContain('is failed');
  });

  it('act as the session a hook names, not the one the server was started for', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    await codex().call('inbox');
    const server = claude('session-before-clear');
    const first = jobNumber(await server.call('delegate', { to: 'codex', task: 'First job' }));

    const second = jobNumber(
      await server.call(
        'delegate',
        { to: 'codex', task: 'Second job' },
        { hint: { harness: 'claude-code', session: 'session-after-clear' } }
      )
    );

    const reader = await BridgeClient.connect({ socketPath: bridgePaths({ home }).socket });
    try {
      const [before, after] = [await reader.job(first), await reader.job(second)];
      expect(before.from).not.toBe(after.from);
      const agents = await reader.agents({ harness: 'claude-code' });
      expect(agents.map((agent) => agent.sessionId).sort()).toEqual([
        'session-after-clear',
        'session-before-clear',
      ]);
    } finally {
      await reader.close();
    }
  });

  it('show a job of others without its letters', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    await codex().call('inbox');
    const job = jobNumber(
      await claude().call('delegate', { to: 'codex', task: 'Rotate the signing key' })
    );

    const seen = await claude('session-other').call('job', { job });

    expect(seen).toContain(`#${job} working`);
    expect(seen).toContain('"Rotate the signing key"');
    expect(seen).toContain('this session is neither');
    expect(seen).not.toContain('task from');
  });

  it('take a job back and tell the agent that had it', async () => {
    const adapter = new FakeAdapter({ harness: 'codex' });
    await startHost({ adapters: [adapter] });
    await codex().call('inbox');
    const orchestrator = claude();
    const job = jobNumber(await orchestrator.call('delegate', { to: 'codex', task: 'Port it' }));

    expect(await orchestrator.call('cancel', { job, reason: 'Not needed any more' })).toMatch(
      new RegExp(`Job #${job} is canceled, codex@.+ is told`)
    );
    expect(adapter.texts.at(-1)).toContain('Not needed any more');
    await expect(codex().call('cancel', { job })).rejects.toThrow();
  });

  it('list who can take a job and what the bridge can start', async () => {
    await startHost({
      adapters: [
        new FakeAdapter({
          harness: 'codex',
          createSession: async () => ({ sessionId: 'thread-new' }),
        }),
      ],
    });
    await codex().call('inbox');

    const listed = await claude().call('agents');

    expect(listed).toMatch(/claude@\S+ {2}claude-code, this session/);
    expect(listed).toMatch(/codex@\S+ {2}codex/);
    expect(listed).toContain('The bridge starts a session for a job handed to: codex');
  });

  it('say so when the bridge can start nothing', async () => {
    await startHost();

    expect(await claude().call('agents')).toContain('The bridge cannot start sessions here');
  });

  it('pass on what the bridge refuses, in its own words', async () => {
    await startHost();
    const orchestrator = claude();

    await expect(orchestrator.call('delegate', { to: 'codex', task: 'Do it' })).rejects.toThrow(
      /No codex session works in this project/
    );
    await expect(orchestrator.call('report', { job: 41, result: 'Done' })).rejects.toThrow(/41/);
  });

  it('decide a permission request: allow it, refuse it, or leave it to the user', async () => {
    const asked: string[] = [];
    await startHost({
      rights: ({ ask }) => (ask.command?.startsWith('git push') ? 'allow' : 'ask'),
      person: { ask: ({ letter }) => void asked.push(letter.kind), settle: () => undefined },
    });
    const orchestrator = claude();
    const worker = codex();
    await worker.call('inbox');
    const job = jobNumber(await orchestrator.call('delegate', { to: 'codex', task: 'Ship it' }));
    await worker.call('inbox');
    const raw = await BridgeClient.connect({
      socketPath: bridgePaths({ home }).socket,
      caller: { harness: 'codex', sessionId: 'thread-codex', cwd: project },
    });
    const request = (command: string) =>
      raw.send({
        job,
        kind: 'permission',
        body: `Run \`${command}\``,
        ask: { tool: 'Bash', access: 'command', command },
      });

    try {
      const push = await request('git push origin main');
      expect(await orchestrator.call('inbox')).toContain('[agent bridge] Yours to decide');
      expect(await orchestrator.call('answer', { job, decision: 'allow' })).toMatch(
        /^Allowed codex@\S+\. Job #1 is working\.$/
      );
      expect(await raw.verdict({ letter: push.letter.id })).toMatchObject({
        verdict: 'allow',
        reason: 'Allowed',
      });

      const tag = await request('git tag v1');
      await expect(orchestrator.call('answer', { job, decision: 'allow' })).rejects.toThrow(
        /is the person's to allow/
      );
      expect(
        await orchestrator.call('answer', { job, decision: 'deny', answer: 'No tags today' })
      ).toMatch(/^Refused codex@/);
      expect(await raw.verdict({ letter: tag.letter.id })).toMatchObject({
        verdict: 'deny',
        reason: 'No tags today',
      });

      await worker.call('ask', { job, question: 'Which release?' });
      await expect(orchestrator.call('answer', { job })).rejects.toThrow(
        /Say the answer, or the decision/
      );
      expect(await orchestrator.call('answer', { job, decision: 'person' })).toMatch(
        /^Left to the user: their answer goes to codex@\S+\. Tell the user in one line that codex@\S+ waits for their word on job #1, which they give with "cogitator bridge asks"\.$/
      );
      expect(asked).toEqual(['permission', 'question']);
    } finally {
      await raw.close();
    }
  });

  it('tell the agent what to tell the user when no dispatcher runs', async () => {
    await expect(claude().call('jobs')).rejects.toThrow(
      /No bridge dispatcher runs on this machine.+cogitator bridge serve/
    );
  });

  it('tell the agent when nothing says which session is calling', async () => {
    await startHost();

    await expect(session({}).call('jobs')).rejects.toThrow(
      /cannot tell which session is calling.+cogitator bridge doctor/
    );
  });

  it('go on working after the dispatcher was restarted', async () => {
    const first = await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    const orchestrator = claude();
    await codex().call('inbox');
    const job = jobNumber(await orchestrator.call('delegate', { to: 'codex', task: 'Do it' }));
    await first.close();
    hosts.length = 0;

    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });

    expect(await orchestrator.call('jobs')).toContain(`#${job} `);
  });
});
