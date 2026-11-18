import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApprovalDecision, ToolApprovalRequest } from '@cogitator-ai/types';
import {
  cogitatorSessions,
  hostedAdapter,
  permissionAskOf,
  providerSessions,
  type HostedRun,
  type HostedSessionContext,
  type HostedTurn,
  type HostedTurnContext,
  type ProviderTurn,
} from '../adapters/hosted';
import { makeKit, MINUTE, type Kit } from './bridge-kit';

let kit: Kit;

afterEach(async () => {
  await kit.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A hosted agent whose turns the test ends by hand */
function scripted(options: { steer?: boolean; followUp?: boolean } = {}) {
  const turns: {
    text: string;
    job: number | undefined;
    steered: string[];
    followed: string[];
    aborted: boolean;
    approve: HostedTurnContext['approve'];
    end: (answer: string) => void;
    fail: (error: Error) => void;
  }[] = [];
  const opened: HostedSessionContext[] = [];
  let closed = 0;
  const open = (context: HostedSessionContext) => {
    opened.push(context);
    return {
      turn(text: string, about?: HostedTurnContext): HostedTurn {
        const result = deferred<string>();
        const turn = {
          text,
          job: about?.job?.number,
          steered: [] as string[],
          followed: [] as string[],
          aborted: false,
          approve: about?.approve,
          end: result.resolve,
          fail: result.reject,
        };
        turns.push(turn);
        return {
          result: result.promise,
          ...(options.steer && {
            steer: (message: string) => {
              turn.steered.push(message);
              return true;
            },
          }),
          ...(options.followUp && {
            followUp: (message: string) => {
              turn.followed.push(message);
              return true;
            },
          }),
          abort: () => {
            turn.aborted = true;
            result.reject(new Error('aborted'));
          },
        };
      },
      close: async () => {
        closed += 1;
      },
    };
  };
  return { open, turns, opened, closedCount: () => closed };
}

/** Lets what is on its way run, without waiting for a session that is still being opened */
async function ticks(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function settle(kitNow: Kit): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await kitNow.bridge.idle();
  }
}

describe('sessions the host runs', () => {
  it('starts a session for a job and reports the answer of the agent', async () => {
    const agent = scripted();
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;

    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);

    expect(agent.opened).toMatchObject([
      { agentName: 'qwen@demo', cwd: '/work/demo', project: '/work/demo', job: { number: 1 } },
    ]);
    expect(agent.turns[0].text.split('\n')).toEqual([
      '[agent bridge] job #1 "Review the diff" | task from claude@demo to qwen@demo | letter ltr_1 | not typed by the user',
      'Review the diff',
    ]);
    expect(await bridge.job(1)).toMatchObject({ state: 'working', to: 'qwen@demo' });
    const [hosted] = await bridge.agents({ harness: 'qwen' });
    expect(hosted).toMatchObject({
      status: 'active',
      delivery: 'hosted',
      capabilities: { createSession: true, push: true, steer: false, nativeWindow: false },
    });
    expect(hosted.sessionId).toBe(agent.opened[0].sessionId);

    agent.turns[0].end('  Two problems found  ');
    await settle(kit);

    expect((await bridge.job(1)).state).toBe('completed');
    expect((await bridge.inbox(claude.name))[0]).toMatchObject({
      kind: 'report',
      from: 'qwen@demo',
      body: 'Two problems found',
      outcome: 'completed',
    });
    expect(kit.errors).toEqual([]);
  });

  it('reports a failure when the agent fails, and an empty answer as done', async () => {
    const agent = scripted();
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await bridge.createJob(claude.name, { to: 'qwen:new', body: 'Run the linter' });
    await settle(kit);

    agent.turns[0].fail(new Error('the model is not reachable'));
    agent.turns[1].end('   ');
    await settle(kit);

    expect(await bridge.job(1)).toMatchObject({ state: 'failed' });
    expect((await bridge.job(2)).state).toBe('completed');
    const reports = await bridge.inbox(claude.name);
    expect(reports.map((letter) => [letter.job, letter.body, letter.outcome])).toEqual([
      [1, 'The agent failed: the model is not reachable', 'failed'],
      [2, 'Done', 'completed'],
    ]);
  });

  it('tells the bridge when the provider of the agent takes no more requests, and fails no job by it', async () => {
    const agent = scripted();
    const other = scripted();
    kit = await makeKit({
      adapters: [
        hostedAdapter({ harness: 'deepseek', open: agent.open }),
        hostedAdapter({ harness: 'qwen', open: other.open }),
      ],
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'deepseek', body: 'Draft the parser' });
    await settle(kit);
    await bridge.createJob(claude.name, { to: 'deepseek@demo', body: 'Draft the printer' });
    await settle(kit);
    expect(agent.turns).toHaveLength(1);

    agent.turns[0].fail(
      Object.assign(new Error('[deepseek] Rate limit exceeded'), {
        code: 'LLM_RATE_LIMITED',
        retryAfter: 120_000,
      })
    );
    const job = await vi.waitFor(async () => {
      const now = await bridge.job(1);
      expect(now.to).toBe('qwen@demo');
      return now;
    });
    await settle(kit);
    expect(job.state).toBe('working');
    expect(job.redirects?.[0]).toMatchObject({
      from: 'deepseek@demo',
      why: 'ran into the limit of deepseek ([deepseek] Rate limit exceeded)',
    });
    expect((await bridge.status()).limited).toMatchObject([{ harness: 'deepseek', told: true }]);
    await vi.waitFor(async () => expect((await bridge.job(2)).to).toMatch(/^qwen/));
    await settle(kit);
    expect(agent.turns).toHaveLength(1);
    expect(other.turns).toHaveLength(2);
    expect(other.turns[0].text).toContain('deepseek@demo had this job before you');
    other.turns[0].end('Drafted');
    other.turns[1].end('Drafted too');
    await settle(kit);
    expect((await bridge.job(1)).state).toBe('completed');
    expect((await bridge.job(2)).state).toBe('completed');
    expect(kit.errors).toEqual([]);
  });

  it('hears an agent that answers at once, or cannot even start its turn', async () => {
    const adapter = hostedAdapter({
      harness: 'qwen',
      open: ({ job }) => ({
        turn: () => {
          if (job.number === 2) throw new Error('no such model');
          return { result: Promise.resolve('Nothing to fix') };
        },
      }),
    });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude } = kit;

    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await bridge.createJob(claude.name, { to: 'qwen:new', body: 'Run the linter' });
    await settle(kit);

    expect((await bridge.job(1)).state).toBe('completed');
    expect((await bridge.job(2)).state).toBe('failed');
    const reports = await bridge.inbox(claude.name);
    expect(reports.map((letter) => [letter.job, letter.body])).toEqual([
      [1, 'Nothing to fix'],
      [2, 'The agent failed: no such model'],
    ]);
    expect(await bridge.agents({ harness: 'qwen' })).toHaveLength(2);
    expect(kit.errors).toEqual([]);
  });

  it('reaches the agent in the middle of its turn with what it waits for', async () => {
    const agent = scripted({ steer: true, followUp: true });
    kit = await makeKit({
      adapters: [hostedAdapter({ harness: 'qwen', steer: true, open: agent.open })],
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);

    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Skip the generated files' });
    await settle(kit);

    expect(agent.turns).toHaveLength(1);
    expect(agent.turns[0].steered.map((text) => text.split('\n')[1])).toEqual([
      'Skip the generated files',
    ]);
    expect((await bridge.agents({ harness: 'qwen' }))[0].capabilities.steer).toBe(true);
    expect((await bridge.letters({ job: 1, kinds: ['note'] }))[0].state).toBe('delivered');
  });

  it('gives a second job its own turn, so each gets its own report', async () => {
    const agent = scripted({ steer: true, followUp: true });
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Run the linter' });
    await settle(kit);
    expect(agent.turns).toHaveLength(1);
    expect(agent.turns[0].followed).toEqual([]);

    agent.turns[0].end('Looks fine');
    await settle(kit);
    expect(agent.turns).toHaveLength(2);
    expect(agent.turns[1].text).toContain('Run the linter');
    agent.turns[1].end('No warnings');
    await settle(kit);

    expect((await bridge.inbox(claude.name)).map((letter) => [letter.job, letter.body])).toEqual([
      [1, 'Looks fine'],
      [2, 'No warnings'],
    ]);
  });

  it('does not start a job that was canceled while it waited for its turn', async () => {
    const agent = scripted();
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Run the linter' });
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Update the changelog' });
    await settle(kit);
    await bridge.cancel(claude.name, 2, 'Not needed any more');
    await settle(kit);

    agent.turns[0].end('Looks fine');
    await settle(kit);

    expect(agent.turns.map((turn) => turn.text.split('\n')[1])).toEqual([
      'Review the diff',
      'Update the changelog',
    ]);
    expect((await bridge.job(2)).state).toBe('canceled');
    agent.turns[1].end('Done');
    await settle(kit);
    expect((await bridge.job(3)).state).toBe('completed');
    expect(agent.turns).toHaveLength(2);
    expect(kit.errors).toEqual([]);
  });

  it('keeps what is written about a job that waits for its turn for that turn', async () => {
    const agent = scripted({ steer: true, followUp: true });
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Run the linter' });
    await settle(kit);
    await bridge.send(claude.name, { job: 2, kind: 'note', body: 'Only the bridge package' });
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Skip the generated files' });
    await settle(kit);

    expect(agent.turns).toHaveLength(1);
    expect(agent.turns[0].job).toBe(1);
    expect(agent.turns[0].steered).toHaveLength(1);
    expect(agent.turns[0].steered[0]).toContain('Skip the generated files');
    expect(agent.turns[0].followed).toEqual([]);

    agent.turns[0].end('Looks fine');
    await settle(kit);

    expect(agent.turns).toHaveLength(2);
    expect(agent.turns[1].job).toBe(2);
    expect(agent.turns[1].text).toContain('Run the linter');
    expect(agent.turns[1].steered).toHaveLength(1);
    expect(agent.turns[1].steered[0]).toContain('Only the bridge package');
    agent.turns[1].end('No warnings');
    await settle(kit);
    expect(agent.turns).toHaveLength(2);
    expect(kit.errors).toEqual([]);
  });

  it('tells no turn about a job that was canceled before its own', async () => {
    const agent = scripted({ steer: true, followUp: true });
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Run the linter' });
    await settle(kit);
    await bridge.send(claude.name, { job: 2, kind: 'note', body: 'Only the bridge package' });
    await bridge.cancel(claude.name, 2, 'Not needed any more');
    await settle(kit);

    expect(agent.turns[0].steered).toEqual([]);
    expect(agent.turns[0].followed).toEqual([]);
    expect(agent.turns[0].aborted).toBe(false);
    agent.turns[0].end('Looks fine');
    await settle(kit);

    expect(agent.turns).toHaveLength(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(kit.errors).toEqual([]);
  });

  it('does not start a job that was canceled while its session was opening', async () => {
    const agent = scripted();
    const opening = deferred<undefined>();
    kit = await makeKit({
      adapters: [
        hostedAdapter({
          harness: 'qwen',
          open: async (context) => {
            await opening.promise;
            return agent.open(context);
          },
        }),
      ],
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await ticks();
    await bridge.cancel(claude.name, 1, 'Not needed any more');
    await ticks();

    opening.resolve(undefined);
    await settle(kit);

    expect(agent.opened).toHaveLength(1);
    expect(agent.turns).toEqual([]);
    expect((await bridge.job(1)).state).toBe('canceled');

    await bridge.createJob(claude.name, { to: 'qwen', body: 'Run the linter' });
    await settle(kit);
    expect(agent.turns.map((turn) => turn.job)).toEqual([2]);
    expect(kit.errors).toEqual([]);
  });

  it('stops the turn of a job that is canceled, and reports nothing for it', async () => {
    const agent = scripted({ steer: true });
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Take your time' });
    await settle(kit);
    expect(agent.turns[0].aborted).toBe(false);

    await bridge.cancel(claude.name, 1, 'Not needed any more');
    await settle(kit);

    expect(agent.turns[0].aborted).toBe(true);
    expect((await bridge.job(1)).state).toBe('canceled');
    expect((await bridge.letters({ job: 1, kinds: ['report'] })).length).toBe(0);
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Run the linter' });
    await settle(kit);
    expect(agent.turns[1].text).toContain('Run the linter');
    expect(kit.errors).toEqual([]);
  });

  it('keeps a letter for the next turn when the turn takes nothing', async () => {
    const agent = scripted();
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, {
      to: 'qwen',
      body: 'Review the diff',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    await settle(kit);
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Skip the generated files' });
    await settle(kit);
    expect(agent.turns).toHaveLength(1);

    agent.turns[0].end('Looks fine');
    await settle(kit);

    expect(agent.turns).toHaveLength(2);
    expect(agent.turns[1].text).toContain('Skip the generated files');
    expect((await bridge.job(1)).state).toBe('completed');
    agent.turns[1].end('Noted');
    await settle(kit);
    expect(await bridge.inbox(claude.name)).toHaveLength(1);
    expect(kit.errors).toEqual([]);
  });

  it('lists what it runs, so a session lost with the host is gone at the next look', async () => {
    const agent = scripted();
    const adapter = hostedAdapter({ harness: 'qwen', open: agent.open });
    kit = await makeKit({ adapters: [adapter] });
    const { bridge, claude, clock } = kit;
    await bridge.register({
      harness: 'qwen',
      sessionId: 'from-a-host-that-died',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, { to: 'qwen:new', body: 'Review the diff' });
    await settle(kit);
    expect(await adapter.liveSessions?.()).toMatchObject([
      { sessionId: agent.opened[0].sessionId, cwd: '/work/demo', busy: true },
    ]);

    clock.advance(MINUTE);
    await bridge.sweep();
    await settle(kit);

    const agents = await bridge.agents({ harness: 'qwen' });
    expect(Object.fromEntries(agents.map((hosted) => [hosted.sessionId, hosted.status]))).toEqual({
      'from-a-host-that-died': 'gone',
      [agent.opened[0].sessionId]: 'active',
    });
  });

  it('refuses a letter for a session it does not run, and the bridge tries again', async () => {
    const agent = scripted();
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude } = kit;
    await bridge.register({
      harness: 'qwen',
      sessionId: 'from-a-host-that-died',
      cwd: '/work/demo',
      project: '/work/demo',
    });

    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);

    expect((await bridge.letters({ job: 1 }))[0]).toMatchObject({
      state: 'queued',
      attempts: 1,
      lastError: 'The session of qwen@demo does not run in this host',
    });
  });

  it('stops its sessions with the dispatcher and reports nothing for them', async () => {
    const agent = scripted();
    kit = await makeKit({ adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })] });
    const { bridge, claude, store } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);

    await bridge.close();

    expect(agent.turns[0].aborted).toBe(true);
    expect(agent.closedCount()).toBe(1);
    expect(store.listLetters({ job: 1 }).map((letter) => letter.kind)).toEqual(['task']);
    expect(kit.errors).toEqual([]);
  });

  it('does not wait forever for a turn that ignores being stopped', async () => {
    let closed = false;
    const adapter = hostedAdapter({
      harness: 'qwen',
      stopGraceMs: 20,
      open: () => ({
        turn: () => ({ result: new Promise<string>(() => undefined) }),
        close: async () => {
          closed = true;
        },
      }),
    });
    kit = await makeKit({ adapters: [adapter] });
    await kit.bridge.createJob(kit.claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);

    await kit.bridge.close();

    expect(closed).toBe(true);
  });

  it('fails the job when the session cannot be opened', async () => {
    kit = await makeKit({
      adapters: [
        hostedAdapter({
          harness: 'qwen',
          open: async () => {
            throw new Error('no model named qwen3');
          },
        }),
      ],
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Review the diff' });
    await settle(kit);

    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'the bridge could not start a qwen session: no model named qwen3',
    });
  });
});

const PUSH: ToolApprovalRequest = {
  toolCallId: 'call-1',
  toolName: 'run_command',
  arguments: { command: 'git push origin main' },
  description: 'Push the branch',
};

describe('a call a hosted agent asks leave for', () => {
  /** A hosted agent in the middle of the turn of a job Claude handed it. */
  async function working(options: Parameters<typeof makeKit>[0] = {}) {
    const agent = scripted();
    kit = await makeKit({
      ...options,
      adapters: [hostedAdapter({ harness: 'qwen', open: agent.open })],
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'qwen', body: 'Ship the fix' });
    await settle(kit);
    const approve = agent.turns[0].approve;
    if (!approve) throw new Error('The turn was given no way to ask leave');
    return { bridge, claude, agent, approve };
  }

  it('shows the call without the manual of its tool, which a runtime agent sends as its description', async () => {
    const { bridge, claude, approve } = await working({ rights: () => 'allow' });
    const manual =
      'Run a shell command in the workspace (sh -c), in its current directory or `cwd`. Returns stdout, stderr, the exit code, and whether it timed out or its output was cut. In a workspace whose commands run in an OS sandbox, `sandbox` says how it ran.';

    void approve({ ...PUSH, description: manual });
    void approve({
      ...PUSH,
      toolCallId: 'call-2',
      description: 'Two\nlines',
      arguments: { command: 'ls' },
    });
    await settle(kit);

    const asked = (await bridge.inbox(claude.name)).map((letter) => letter.body);
    expect(asked).toEqual(['Run in /work/demo:\ngit push origin main', 'Run in /work/demo:\nls']);
  });

  it('goes to the agent that handed the job over, whose answer the call gets', async () => {
    const { bridge, claude, approve } = await working({ rights: () => 'allow' });

    const first = approve(PUSH);
    await settle(kit);
    const [request] = await bridge.inbox(claude.name);
    expect(request).toMatchObject({
      kind: 'permission',
      from: 'qwen@demo',
      body: 'Push the branch\nRun in /work/demo:\ngit push origin main',
      ask: {
        tool: 'run_command',
        access: 'command',
        command: 'git push origin main',
        cwd: '/work/demo',
      },
    });
    expect((await bridge.job(1)).state).toBe('input-required');
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Go', verdict: 'allow' });

    expect(await first).toEqual({ approved: true });
    expect((await bridge.job(1)).state).toBe('working');

    const second = approve({ ...PUSH, arguments: { command: 'git push --force' } });
    await settle(kit);
    await bridge.send(claude.name, {
      job: 1,
      kind: 'answer',
      body: 'Never force',
      verdict: 'deny',
    });

    expect(await second).toEqual({
      approved: false,
      reason: 'Refused by claude@demo: Never force',
    });
    expect(kit.errors).toEqual([]);
  });

  it('shows the environment a command sets for itself to whoever decides', async () => {
    const { bridge, claude, approve } = await working({ rights: () => 'allow' });

    const waiting = approve({
      ...PUSH,
      arguments: { command: 'ls .', env: { LD_PRELOAD: '/tmp/x.so' } },
    });
    await settle(kit);
    const [request] = await bridge.inbox(claude.name);

    expect(request.body).toBe(
      'Push the branch\nRun in /work/demo with LD_PRELOAD=/tmp/x.so:\nls .'
    );
    expect(request.ask).toMatchObject({ env: { LD_PRELOAD: '/tmp/x.so' } });
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'No', verdict: 'deny' });
    await waiting;
  });

  it('is refused at once by the rules of the one who handed the job over', async () => {
    const { approve } = await working({ rights: () => 'deny' });

    expect(await approve(PUSH)).toEqual({
      approved: false,
      reason: 'Refused by bridge: The rules of claude@demo forbid this, so it is refused',
    });
  });

  it('waits for the person when it is theirs to allow', async () => {
    const { bridge, approve } = await working({
      rights: () => 'ask',
      person: { ask: () => undefined, settle: () => undefined },
    });

    const waiting = approve(PUSH);
    await settle(kit);
    const [{ letter }] = await bridge.forPerson();
    await bridge.personAnswer({ letter: letter.id, verdict: 'allow' });

    expect(await waiting).toEqual({ approved: true });
  });

  it('is refused when its job is canceled, and when the bridge does not take the request', async () => {
    const { bridge, claude, agent, approve } = await working({ rights: () => 'allow' });

    const waiting = approve(PUSH);
    await settle(kit);
    await bridge.cancel(claude.name, 1, 'Not needed');

    expect(await waiting).toEqual({
      approved: false,
      reason:
        'Refused by bridge: Nobody answered before job #1 was canceled (canceled by claude@demo: Not needed)',
    });
    await settle(kit);
    expect(agent.turns[0].aborted).toBe(true);
    expect(await approve(PUSH)).toEqual({
      approved: false,
      reason:
        'Job 1 is canceled (canceled by claude@demo: Not needed). Hand over a new job to go on',
    });
  });

  it('keeps looking for the verdict, and rests between looks that come back at once', async () => {
    const { bridge, claude, approve } = await working({ rights: () => 'allow' });
    const looks = vi.spyOn(bridge, 'verdict');
    looks.mockResolvedValueOnce({ state: 'waiting' }).mockResolvedValueOnce({ state: 'waiting' });
    const started = Date.now();

    const waiting = approve(PUSH);
    await settle(kit);
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Go', verdict: 'allow' });

    expect(await waiting).toEqual({ approved: true });
    expect(looks).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  it('says what a call touches, from the name of its tool and its arguments', () => {
    const at = { cwd: '/work/demo' };
    const of = (toolName: string, args: Record<string, unknown>) =>
      permissionAskOf({ toolName, arguments: args }, at);

    expect(of('exec', { command: 'pnpm test', cwd: 'packages/core' })).toEqual({
      tool: 'exec',
      access: 'command',
      command: 'pnpm test',
      cwd: '/work/demo/packages/core',
    });
    expect(of('read_file', { path: 'README.md' })).toEqual({
      tool: 'read_file',
      access: 'read',
      paths: ['/work/demo/README.md'],
    });
    expect(of('edit_file', { paths: ['src/a.ts', '/etc/hosts', 7] })).toEqual({
      tool: 'edit_file',
      access: 'edit',
      paths: ['/work/demo/src/a.ts', '/etc/hosts'],
    });
    expect(of('web_fetch', { url: 'https://example.com' })).toEqual({
      tool: 'web_fetch',
      access: 'fetch',
      url: 'https://example.com',
    });
    expect(of('acp__gemini__deploy', { target: 'prod' })).toEqual({
      tool: 'acp__gemini__deploy',
      access: 'other',
    });
    expect(of('exec', { command: 'ls .', env: { LD_PRELOAD: '/tmp/x.so' } })).toEqual({
      tool: 'exec',
      access: 'command',
      command: 'ls .',
      cwd: '/work/demo',
      env: { LD_PRELOAD: '/tmp/x.so' },
    });
    expect(of('run_command', { command: 'ls', env: [{ name: 'A', value: '1' }] })).toMatchObject({
      access: 'command',
      env: { A: '1' },
    });
    expect(of('run_command', { command: 'ls', env: {} })).not.toHaveProperty('env');
    expect(of('run_command', { command: 'ls', env: { A: 1 } })).toEqual({
      tool: 'run_command',
      access: 'other',
    });
    expect(of('run_command', {})).toEqual({ tool: 'run_command', access: 'other' });
    expect(of('edit_file', {})).toEqual({ tool: 'edit_file', access: 'other' });
  });
});

describe('agents of the runtime as hosted sessions', () => {
  it('runs every turn on the thread of the session and passes steering on', async () => {
    const started: { agent: string; input: string; threadId: string }[] = [];
    const runs: { steered: string[]; followed: string[]; aborted: unknown[] }[] = [];
    const runtime = {
      start(agent: string, options: { input: string; threadId: string }): HostedRun {
        started.push({ agent, ...options });
        const run = { steered: [] as string[], followed: [] as string[], aborted: [] as unknown[] };
        runs.push(run);
        return {
          result: Promise.resolve({ output: `answer to ${options.input}` }),
          steer: (message) => run.steered.push(message) > 0,
          followUp: (message) => run.followed.push(message) > 0,
          abort: (reason) => run.aborted.push(reason),
        };
      },
    };
    const context: HostedSessionContext = {
      sessionId: 'abc',
      agentName: 'qwen@demo',
      cwd: '/work/demo',
      project: '/work/demo',
      job: {} as HostedSessionContext['job'],
    };
    const seen: HostedSessionContext[] = [];
    const session = await cogitatorSessions({
      runtime,
      agent: (opened) => {
        seen.push(opened);
        return 'reviewer';
      },
    })(context);

    const first = session.turn('one');
    const second = session.turn('two');

    expect(await first.result).toBe('answer to one');
    expect(await second.result).toBe('answer to two');
    expect(started).toEqual([
      { agent: 'reviewer', input: 'one', threadId: 'bridge-abc' },
      { agent: 'reviewer', input: 'two', threadId: 'bridge-abc' },
    ]);
    expect(seen).toEqual([context]);
    expect(first.steer?.('now')).toBe(true);
    expect(first.followUp?.('later')).toBe(true);
    first.abort?.('stop');
    expect(runs[0]).toEqual({ steered: ['now'], followed: ['later'], aborted: ['stop'] });

    const fixed = await cogitatorSessions({ runtime, agent: 'writer' })(context);
    await fixed.turn('three').result;
    expect(started[2].agent).toBe('writer');
  });

  it('fails the job of a run that paused for an approval, instead of reporting it done', async () => {
    const runtime = {
      start: (): HostedRun => ({
        result: Promise.resolve({ output: 'I need to run rm -rf build', status: 'paused' }),
        steer: () => false,
        followUp: () => false,
        abort: () => undefined,
      }),
    };
    kit = await makeKit({
      adapters: [
        hostedAdapter({ harness: 'qwen', open: cogitatorSessions({ runtime, agent: 'writer' }) }),
      ],
    });
    const { bridge, claude } = kit;

    await bridge.createJob(claude.name, { to: 'qwen', body: 'Clean the build' });
    for (let round = 0; round < 5; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await bridge.idle();
    }

    expect((await bridge.job(1)).state).toBe('failed');
    const [report] = await bridge.inbox(claude.name);
    expect(report).toMatchObject({ kind: 'report', outcome: 'failed' });
    expect(report.body).toBe(
      'The agent failed: the run stopped to wait for an answer nobody gives in a hosted session: a question of a tool, or an approval the runtime did not ask the bridge for'
    );
  });

  it('hands the runtime the way to ask leave, so a run asks the bridge instead of pausing', async () => {
    const asked: unknown[] = [];
    const runtime = {
      start(
        _agent: string,
        options: {
          input: string;
          onApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision | 'pause'>;
        }
      ): HostedRun {
        return {
          result: (async () => {
            const answer = await options.onApproval?.(PUSH);
            asked.push(answer);
            return { output: 'Pushed' };
          })(),
          steer: () => false,
          followUp: () => false,
          abort: () => undefined,
        };
      },
    };
    kit = await makeKit({
      rights: () => 'allow',
      adapters: [
        hostedAdapter({ harness: 'qwen', open: cogitatorSessions({ runtime, agent: 'writer' }) }),
      ],
    });
    const { bridge, claude } = kit;

    await bridge.createJob(claude.name, { to: 'qwen', body: 'Ship the fix' });
    await settle(kit);
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Go', verdict: 'allow' });
    await settle(kit);

    expect(asked).toEqual([{ approved: true }]);
    expect(await bridge.job(1)).toMatchObject({ state: 'completed' });
  });
});

describe('agents behind a session provider as hosted sessions', () => {
  const context: HostedSessionContext = {
    sessionId: 'abc',
    agentName: 'gemini@demo',
    cwd: '/work/demo',
    project: '/work/demo',
    job: {} as HostedSessionContext['job'],
  };

  it('runs a turn as a prompt of one thread and keeps what the provider saves between turns', async () => {
    const turns: ProviderTurn[] = [];
    const provider = {
      async runTurn(turn: ProviderTurn) {
        turns.push(turn);
        const session = turn.metadata.acpSession ?? 'new';
        await turn.saveMetadata({ acpSession: 'session-1' });
        await turn.setPermissionMode('acceptEdits');
        return { output: `${String(session)}: ${turn.input[0].text}` };
      },
    };
    const session = await providerSessions({ provider, root: '/work/demo' })(context);

    expect(await session.turn('one').result).toBe('new: one');
    expect(await session.turn('two').result).toBe('session-1: two');

    expect(turns.map((turn) => turn.threadId)).toEqual(['bridge-abc', 'bridge-abc']);
    expect(turns[0].turnId).not.toBe(turns[1].turnId);
    expect(turns[1].permissionMode()).toBe('acceptEdits');
    expect(turns[0].input).toEqual([{ type: 'text', text: 'one' }]);
  });

  it('starts in the permission mode it was given, and takes a refusal for a failure', async () => {
    const modes: string[] = [];
    const provider = {
      async runTurn(turn: ProviderTurn) {
        modes.push(turn.permissionMode());
        return { output: 'I cannot help with that', refused: true };
      },
    };
    const session = await providerSessions({ provider, root: '/work', permissionMode: 'plan' })(
      context
    );

    await expect(session.turn('one').result).rejects.toThrow('I cannot help with that');
    expect(modes).toEqual(['plan']);
  });

  it('hands the provider the way to ask leave for a call its rules do not settle', async () => {
    const asked: unknown[] = [];
    const provider = {
      async runTurn(turn: ProviderTurn) {
        asked.push(await turn.onApproval?.(PUSH));
        return { output: 'done' };
      },
    };
    const session = await providerSessions({ provider, root: '/work/demo' })(context);

    await session.turn('one', { approve: async () => ({ approved: false, reason: 'No' }) }).result;
    await session.turn('two').result;

    expect(asked).toEqual([{ approved: false, reason: 'No' }, undefined]);
  });

  it('refuses a job for a folder its one provider does not work in', async () => {
    const provider = { runTurn: async () => ({ output: 'never' }) };
    const open = providerSessions({ provider, root: '/work/demo' });

    await expect(open({ ...context, cwd: '/work/other' })).rejects.toThrow(
      'this agent works in /work/demo, and the job is for /work/other. Hand it a job in its own folder'
    );
    await expect(open({ ...context, cwd: '/work/demo/packages/core' })).resolves.toBeDefined();
    expect(() => providerSessions({ provider })).toThrow('providerSessions needs `root`');
  });

  it('fails a later job of a session for a folder its provider does not work in', async () => {
    const ran: string[] = [];
    const provider = {
      async runTurn(turn: ProviderTurn) {
        ran.push(turn.input[0].text.split('\n')[1]);
        return { output: 'done' };
      },
    };
    kit = await makeKit({
      adapters: [
        hostedAdapter({
          harness: 'gemini',
          open: providerSessions({ provider: () => provider }),
        }),
      ],
    });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, {
      to: 'gemini',
      body: 'Review core',
      cwd: 'packages/core',
    });
    await settle(kit);
    const [gemini] = await bridge.agents({ harness: 'gemini' });
    expect(gemini.cwd).toBe('/work/demo/packages/core');

    await bridge.createJob(claude.name, {
      to: gemini.name,
      body: 'Review cli',
      cwd: 'packages/cli',
    });
    await bridge.createJob(claude.name, {
      to: gemini.name,
      body: 'Review the tests of core',
      cwd: 'packages/core/src/__tests__',
    });
    await settle(kit);

    expect(ran).toEqual(['Review core', 'Review the tests of core']);
    expect((await bridge.job(1)).state).toBe('completed');
    expect((await bridge.job(3)).state).toBe('completed');
    expect((await bridge.job(2)).state).toBe('failed');
    const [refusal] = await bridge.letters({ job: 2, kinds: ['report'] });
    expect(refusal.body).toBe(
      'The agent failed: this agent works in /work/demo/packages/core, and the job is for /work/demo/packages/cli. Hand it a job in its own folder'
    );
    expect(kit.errors).toEqual([]);
  });

  it('makes a provider for the folder of each session, and closes the ones it made', async () => {
    const made: { cwd: string; closed: boolean }[] = [];
    const open = providerSessions({
      provider: (opened) => {
        const record = { cwd: opened.cwd, closed: false };
        made.push(record);
        return {
          runTurn: async () => ({ output: `done in ${opened.cwd}` }),
          close: async () => {
            record.closed = true;
          },
        };
      },
    });

    const here = await open(context);
    const there = await open({ ...context, sessionId: 'def', cwd: '/work/other' });

    expect(await here.turn('one').result).toBe('done in /work/demo');
    expect(await there.turn('one').result).toBe('done in /work/other');
    await here.close?.();
    expect(made).toEqual([
      { cwd: '/work/demo', closed: true },
      { cwd: '/work/other', closed: false },
    ]);
    const shared = await providerSessions({
      provider: { runTurn: async () => ({ output: 'x' }), close: async () => undefined },
      root: '/work',
    })(context);
    expect(shared.close).toBeUndefined();
  });

  it('aborts the signal of the turn when the turn is stopped', async () => {
    let signal: AbortSignal | undefined;
    const provider = {
      runTurn(turn: ProviderTurn) {
        signal = turn.signal;
        return new Promise<{ output: string }>((_, reject) => {
          turn.signal.addEventListener('abort', () => reject(new Error('cancelled')));
        });
      },
    };
    const session = await providerSessions({ provider, root: '/work/demo' })(context);
    const turn = session.turn('one');

    turn.abort?.(new Error('stop'));

    await expect(turn.result).rejects.toThrow('cancelled');
    expect(signal?.aborted).toBe(true);
    expect(turn.steer).toBeUndefined();
  });
});
