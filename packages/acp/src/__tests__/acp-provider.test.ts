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
import { fakeAcpAgent } from './fake-agent';
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

function setup(options: Partial<AcpAgentProviderOptions> = {}) {
  const fake = fakeAcpAgent();
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
