import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionHost,
  type AppServerNotification,
  type TurnInfo,
  type TurnStartOptions,
} from '@cogitator-ai/app-server';
import { Cogitator, LocalWorkspace } from '@cogitator-ai/core';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import { AcpAgentProvider, type AcpAgentProviderOptions } from '../client/provider';
import { SILENT_AGENT_ARGS, fakeAcpAgent } from './fake-agent';
import { waitUntil } from './helpers';

let dir: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-provider-')));
  workspace = new LocalWorkspace({ root: dir });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function setup(
  options: Partial<AcpAgentProviderOptions> = {},
  agentOptions: Parameters<typeof fakeAcpAgent>[0] = {}
) {
  const fake = fakeAcpAgent(agentOptions);
  const provider = new AcpAgentProvider({
    agent: { app: fake.app },
    workspace,
    name: 'fake',
    description: 'A fake ACP agent',
    authMethodId: 'fake',
    ...options,
  });
  const host = new SessionHost({
    cogitator: new Cogitator({ memory: { adapter: 'memory' } }),
    agents: {},
    providers: { fake: provider },
    exposeErrors: true,
  });
  const notifications: AppServerNotification[] = [];
  host.subscribe((notification) => notifications.push(notification));
  const events = (turnId: string): StreamEvent[] =>
    notifications.flatMap((n) =>
      n.method === 'turn/event' && n.params.turnId === turnId ? [n.params.event] : []
    );
  const completed = async (turnId: string): Promise<TurnInfo> => {
    let found: TurnInfo | undefined;
    await waitUntil(() => {
      for (const n of notifications) {
        if (n.method === 'turn/completed' && n.params.turn.id === turnId) found = n.params.turn;
      }
      return found !== undefined;
    });
    return found!;
  };
  const run = async (threadId: string, text: string, turnOptions: TurnStartOptions = {}) => {
    const turn = await host.startTurn({ threadId, input: [{ type: 'text', text }] }, turnOptions);
    return { done: await completed(turn.id), events: events(turn.id) };
  };
  return { fake, provider, host, notifications, run, completed };
}

describe('AcpAgentProvider', () => {
  it('lists the external agent and streams its turn as stream events kept in the thread', async () => {
    const { host, fake, provider, run } = setup();
    expect(host.agents()).toEqual([
      { name: 'fake', description: 'A fake ACP agent', default: true, external: true },
    ]);
    const thread = await host.startThread({});
    const { done, events } = await run(thread.id, 'speak hello there; plan Fix the bug');
    expect(done).toMatchObject({ status: 'completed', output: 'hello there' });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('finish');
    expect(types).toEqual(
      expect.arrayContaining(['reasoning-delta', 'text-delta', 'tool-call-start', 'tool-result'])
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool-call-start', toolName: 'write_todos' })
    );
    const resumed = await host.resumeThread(thread.id);
    expect(resumed.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'speak hello there; plan Fix the bug'],
      ['assistant', 'hello there'],
    ]);
    expect(resumed.thread.metadata['acp.agentSessionId']).toBe('fake_1');

    await run(thread.id, 'speak again');
    expect(fake.log.sessions).toEqual(['fake_1']);
    expect(fake.log.prompts.map((p) => p.sessionId)).toEqual(['fake_1', 'fake_1']);
    await provider.close();
    await host.close();
  });

  it('decides permission requests with the rules, and asks the client otherwise', async () => {
    const { fake, provider, host, run } = setup({
      permissions: { rules: { allow: ['Bash(echo ok)'] } },
    });
    const thread = await host.startThread({});
    const allowed = await run(thread.id, 'command echo ok');
    expect(allowed.done.status).toBe('completed');
    expect(fake.log.permissions.at(-1)?.outcome).toBe('yes');
    expect(allowed.events).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        result: { output: 'ok', exitCode: 0 },
      })
    );

    const onApproval = vi.fn(async () => ({ approved: false as const }));
    await run(thread.id, 'command echo other', { onApproval });
    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(onApproval.mock.calls[0]).toMatchObject([
      { request: { toolName: 'run_command', arguments: { command: 'echo other' } } },
    ]);
    expect(fake.log.permissions.at(-1)?.outcome).toBe('no');

    await run(thread.id, 'command echo third');
    expect(fake.log.permissions.at(-1)?.outcome).toBe('no');
    await provider.close();
    await host.close();
  });

  it('keeps an always answer as a rule of the thread', async () => {
    const { fake, provider, host, run } = setup();
    const thread = await host.startThread({});
    const onApproval = vi.fn(async () => ({ approved: true as const, remember: true }));
    await run(thread.id, 'command echo hi', { onApproval });
    await run(thread.id, 'command echo hi', { onApproval });
    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(fake.log.permissions.map((p) => p.outcome)).toEqual(['yes', 'yes']);
    await provider.close();
    await host.close();
  });

  it('serves files from the workspace with the permission checks of the mode', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'first line\nsecond line\n');
    const { fake, provider, host, run } = setup();
    const thread = await host.startThread({ permissionMode: 'acceptEdits' });
    const { done } = await run(
      thread.id,
      `read ${join(dir, 'notes.txt')}; write ${join(dir, 'out.txt')}`
    );
    expect(done.output).toBe(' read:first line wrote');
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('written by agent\n');

    await host.setPermissionMode(thread.id, 'plan');
    await run(thread.id, `write ${join(dir, 'planned.txt')}`);
    expect(fake.log.errors.at(-1)).toContain('Permission denied');
    await host.setPermissionMode(thread.id, 'default');
    await run(thread.id, 'write /etc/outside.txt', {
      onApproval: async () => ({ approved: true }),
    });
    expect(fake.log.errors.at(-1)).toMatch(/outside/i);
    expect(fake.log.modes).toEqual(['plan', 'default']);
    await provider.close();
    await host.close();
  });

  it('cancels the agent when the turn is interrupted', async () => {
    const { fake, provider, host, completed } = setup();
    const thread = await host.startThread({});
    const turn = await host.startTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'wait' }],
    });
    await waitUntil(() => fake.log.prompts.length === 1);
    await new Promise((done) => setTimeout(done, 20));
    expect(() =>
      host.steerTurn({
        threadId: thread.id,
        expectedTurnId: turn.id,
        input: [{ type: 'text', text: 'more' }],
      })
    ).toThrow(/takes no messages/);
    host.interruptTurn(thread.id, turn.id);
    expect((await completed(turn.id)).status).toBe('interrupted');
    expect(fake.log.cancels).toEqual(['fake_1']);
    await provider.close();
    await host.close();
  });

  it('checks the environment and directory of a terminal, approved command or not', async () => {
    const { fake, provider, host, run } = setup({
      permissions: { rules: { allow: ['Bash(echo *)'] } },
    });
    const thread = await host.startThread({});
    await run(thread.id, 'command echo plain');
    expect(fake.log.errors).toEqual([]);
    await run(thread.id, 'command echo hi @env=BASH_ENV:/tmp/evil');
    expect(fake.log.permissions.at(-1)?.outcome).toBe('yes');
    expect(fake.log.errors.at(-1)).toContain('Permission denied');

    const onApproval = vi.fn(async () => ({ approved: true as const }));
    await run(thread.id, `command ls build @cwd=${dir}`, { onApproval });
    expect(onApproval).toHaveBeenCalledTimes(1);
    const sub = join(dir, 'sub');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(sub);
    await run(thread.id, `command ls build @cwd=${sub}`, { onApproval });
    expect(onApproval).toHaveBeenCalledTimes(3);
    await provider.close();
    await host.close();
  });

  it('decides an approved command again with the mode and rules of the moment', async () => {
    const { fake, provider, host, run } = setup();
    const thread = await host.startThread({});
    const onApproval = vi.fn(async () => {
      await host.setPermissionMode(thread.id, 'plan');
      return { approved: true as const };
    });
    await run(thread.id, 'command touch made.txt', { onApproval });
    expect(fake.log.permissions.at(-1)?.outcome).toBe('yes');
    expect(fake.log.errors.at(-1)).toContain('Permission denied');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'made.txt'))).toBe(false);
    await provider.close();
    await host.close();
  });

  it('runs the program a terminal names with its exact arguments', async () => {
    const { provider, host, run } = setup();
    const thread = await host.startThread({});
    const { done } = await run(thread.id, 'bash echo "[$BASH_VERSION]"', {
      onApproval: async () => ({ approved: true }),
    });
    expect(done.output).toMatch(/^out:\[\d+\.\d+/);
    await provider.close();
    await host.close();
  });

  it('stops a turn interrupted while the agent starts its session', async () => {
    let release = () => undefined as void;
    const starts = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, provider, host, completed } = setup({}, { sessionStarts: starts });
    const thread = await host.startThread({});
    const turn = await host.startTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'speak late' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    host.interruptTurn(thread.id, turn.id);
    expect((await completed(turn.id)).status).toBe('interrupted');
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.log.prompts).toEqual([]);
    await provider.close();
    await host.close();
  });

  it('keeps the session of the newest start when a cancelled start finishes late', async () => {
    let releaseFirst = () => undefined as void;
    const gates = [
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    ];
    const { fake, provider, host, completed, run } = setup(
      {},
      { sessionStarts: () => gates.shift() }
    );
    const thread = await host.startThread({});
    const first = await host.startTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'speak first' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    host.interruptTurn(thread.id, first.id);
    expect((await completed(first.id)).status).toBe('interrupted');

    await run(thread.id, 'speak second');
    const kept = (await host.getThread(thread.id)).metadata['acp.agentSessionId'];
    expect(kept).toBe('fake_1');

    releaseFirst();
    await waitUntil(() => fake.log.closed.length === 1);
    expect(fake.log.closed).toEqual(['fake_2']);
    expect((await host.getThread(thread.id)).metadata['acp.agentSessionId']).toBe('fake_1');
    await run(thread.id, 'speak third');
    expect(fake.log.prompts.map((prompt) => prompt.sessionId)).toEqual(['fake_1', 'fake_1']);
    await provider.close();
    await host.close();
  });

  it('asks before the agent leaves plan mode and follows the mode picked', async () => {
    const { fake, provider, host, run } = setup();
    const thread = await host.startThread({ permissionMode: 'plan' });
    const onApproval = vi.fn(async () => ({ approved: true as const }));
    await run(thread.id, 'exitplan', { onApproval });
    expect(onApproval).toHaveBeenCalledTimes(1);
    expect(fake.log.permissions.at(-1)?.outcome).toBe('default');
    expect((await host.getThread(thread.id)).permissionMode).toBe('default');
    await provider.close();
    await host.close();
  });

  it('saves no rule for a call it knows only by its kind', async () => {
    const { provider, host, run } = setup();
    const thread = await host.startThread({});
    const onApproval = vi.fn(async (_ask: { request: { suggestedRule?: string } }) => ({
      approved: true as const,
      remember: true,
    }));
    await run(thread.id, 'tool', { onApproval });
    await run(thread.id, 'tool', { onApproval });
    expect(onApproval).toHaveBeenCalledTimes(2);
    expect(onApproval.mock.calls[0]?.[0].request.suggestedRule).toBeUndefined();
    await provider.close();
    await host.close();
  });

  it('refuses what only threads of the runtime can do', async () => {
    const { provider, host } = setup();
    const thread = await host.startThread({});
    await expect(host.rewindThread({ threadId: thread.id, toEntryId: 'e' })).rejects.toThrow(
      /outside the runtime/
    );
    await expect(
      host.startReview({ threadId: thread.id, target: { type: 'custom', instructions: 'x' } })
    ).rejects.toThrow(/outside the runtime/);
    await provider.close();
    await host.close();
  });
});

const never = () => new Promise<void>(() => undefined);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A provider of a silent agent process, and the pid the process reports once it runs */
function silentProcess(options: Partial<AcpAgentProviderOptions> = {}) {
  let stderr = '';
  const provider = new AcpAgentProvider({
    agent: { command: process.execPath, args: SILENT_AGENT_ARGS },
    workspace,
    onStderr: (chunk) => {
      stderr += chunk;
    },
    ...options,
  });
  const pid = async (): Promise<number> => {
    await waitUntil(() => /^\d+$/.test(stderr));
    return Number(stderr);
  };
  return { provider, pid };
}

/** `work`, or a rejection when it has not settled in `ms`: a hang shows as a failed test */
function within<T>(work: Promise<T>, ms = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Not settled in ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

describe('AcpAgentProvider handshake', () => {
  it('gives up on a launched agent that never answers initialize, names it and kills it', async () => {
    const { provider, pid } = silentProcess({ handshakeTimeout: 300 });
    const connecting = provider.connect();
    const failure = await within(
      connecting.then(
        () => undefined,
        (error: Error) => error
      )
    );
    expect(failure?.message).toContain(process.execPath);
    expect(failure?.message).toMatch(/did not answer initialize in 300 ms/);
    expect(failure?.message).toMatch(/not signed in/);
    const child = await pid();
    await waitUntil(() => !alive(child));
    await within(provider.close());
  });

  it('fails the turn of an agent that never answers initialize', async () => {
    const { host, provider, run } = setup({ handshakeTimeout: 100 }, { initializes: never });
    const thread = await host.startThread({});
    const { done } = await run(thread.id, 'speak hello');
    expect(done.status).toBe('failed');
    expect(done.error?.message).toBe('The ACP agent "fake" did not answer initialize in 100 ms');
    await within(provider.close());
    await host.close();
  });

  it('launches the agent again for the turn after one it gave up on', async () => {
    let launches = 0;
    const { host, provider, run } = setup(
      { handshakeTimeout: 100 },
      { initializes: () => (launches++ === 0 ? never() : undefined) }
    );
    const thread = await host.startThread({});
    expect((await run(thread.id, 'speak one')).done.status).toBe('failed');
    const second = await run(thread.id, 'speak two');
    expect(second.done).toMatchObject({ status: 'completed', output: 'two' });
    await provider.close();
    await host.close();
  });

  it('ends a launch in progress when closed, and kills the agent', async () => {
    const { provider, pid } = silentProcess();
    const failure = provider.connect().then(
      () => undefined,
      (error: Error) => error
    );
    const child = await pid();
    await within(provider.close());
    expect((await within(failure))?.message).toMatch(/closed/);
    await waitUntil(() => !alive(child));
  });

  it.each(['initialize', 'authenticate'] as const)(
    'ends a handshake with an agent in this process stuck on %s when closed',
    async (stuck) => {
      const { provider } = setup(
        {},
        stuck === 'initialize' ? { initializes: never } : { authenticates: never }
      );
      const failure = provider.connect().then(
        () => undefined,
        (error: Error) => error
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await within(provider.close());
      expect((await within(failure))?.message).toMatch(/closed/);
    }
  );

  it('ends a turn interrupted while it waits for the agent to answer initialize', async () => {
    const { host, provider, completed } = setup({}, { initializes: never });
    const thread = await host.startThread({});
    const turn = await host.startTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'speak late' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    host.interruptTurn(thread.id, turn.id);
    expect((await completed(turn.id)).status).toBe('interrupted');
    await within(provider.close());
    await host.close();
  });

  it('rejects when the launched agent exits before it answers initialize', async () => {
    const errors: string[] = [];
    const provider = new AcpAgentProvider({
      agent: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
      workspace,
      onError: (error) => errors.push(error.message),
    });
    const failure = await within(
      provider.connect().then(
        () => undefined,
        (error: Error) => error
      )
    );
    expect(failure?.message).toContain(process.execPath);
    expect(failure?.message).toMatch(/exited \(code 3\) before it answered initialize/);
    await within(provider.close());
  });

  it('waits for initialize without a limit when the timeout is 0', async () => {
    const { provider } = setup({ handshakeTimeout: 0 }, { initializes: never });
    let settled = false;
    const failure = provider.connect().then(
      () => undefined,
      (error: Error) => {
        settled = true;
        return error;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    await within(provider.close());
    expect((await within(failure))?.message).toMatch(/closed/);
  });
});
