import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BridgeClient,
  bridgePaths,
  hostBridge,
  inboxItemId,
  type BridgeHost,
  type Rights,
} from '@cogitator-ai/bridge';
import type { Channel } from '@cogitator-ai/types';
import {
  runBridgeAsks,
  runBridgeDecide,
  runBridgeDelegate,
  runBridgeInbox,
  runBridgeReply,
  runBridgeSend,
  type BridgeSessionContext,
} from '../commands/bridge-session.js';
import { describeJournalEntry, runBridgeServe } from '../commands/bridge.js';
import {
  BRIDGE_INBOX_FILE,
  BRIDGE_TELEGRAM_CHAT_ENV,
  BRIDGE_TELEGRAM_TOKEN_ENV,
  BRIDGE_TELEGRAM_USERS_ENV,
  bridgePerson,
} from '../utils/bridge-person.js';
import { UsageError } from '../utils/cli.js';

let home: string;
let project: string;
let lines: string[];
let failures: string[];
const hosts: BridgeHost[] = [];
const clients: BridgeClient[] = [];

function context(env: NodeJS.ProcessEnv = {}): BridgeSessionContext {
  return {
    print: (line) => lines.push(line),
    wake: () => undefined,
    env: { COGITATOR_BRIDGE_HOME: home, ...env },
    cwd: project,
    stdin: async () => undefined,
    adapters: [],
  };
}

const claude = () => context({ CLAUDE_CODE_SESSION_ID: 'claude-1' });
const codex = () => context({ CODEX_THREAD_ID: 'thread-1' });
const person = () => context();

/** A dispatcher that reaches the person the way `serve` does, with rights the test names. */
async function startHost(rights: Rights = 'ask'): Promise<BridgeHost> {
  const reach = bridgePerson({ COGITATOR_BRIDGE_HOME: home });
  const host = await hostBridge({ home, tickMs: 25, rights: () => rights, person: reach.person });
  hosts.push(host);
  return host;
}

/** The Codex thread of the tests as a client, for what the command line has no flag for. */
async function thread(): Promise<BridgeClient> {
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home }).socket,
    caller: { harness: 'codex', sessionId: 'thread-1', cwd: project },
  });
  clients.push(client);
  return client;
}

/** A job Claude handed to Codex, taken by Codex. */
async function handedOver(): Promise<void> {
  await runBridgeInbox({}, codex());
  await runBridgeDelegate('codex', ['Ship the fix'], {}, claude());
  await runBridgeInbox({}, codex());
  lines = [];
}

const leave = (client: BridgeClient, command = 'git push origin main') =>
  client.send({
    job: 1,
    kind: 'permission',
    body: `Run \`${command}\``,
    ask: { tool: 'Bash', access: 'command', command },
  });

const output = () => stripVTControlCharacters(lines.join('\n'));
const failed = () => stripVTControlCharacters(failures.join('\n'));

beforeEach(() => {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  home = mkdtempSync(join(base, 'cb-cli-'));
  project = mkdtempSync(join(base, 'cb-proj-'));
  lines = [];
  failures = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    failures.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('bridge asks, allow and deny', () => {
  it('show what waits for the person, and take their decision to the agent that asked', async () => {
    await startHost();
    await handedOver();
    const codexClient = await thread();
    const { letter } = await leave(codexClient);

    expect(await runBridgeAsks({}, person())).toBe(0);
    expect(output()).toContain('Job #1 "Ship the fix"');
    expect(output()).toContain('asks leave:\n  Run `git push origin main`');
    expect(output()).toContain('Allow: cogitator bridge allow 1   Refuse: cogitator bridge deny 1');
    lines = [];

    expect(
      await runBridgeDecide('allow', '1', ['The', 'branch', 'is', 'reviewed'], {}, person())
    ).toBe(0);

    expect(output()).toMatch(/^Allowed: codex@\S+ is told\. Job #1 is working$/);
    expect(await codexClient.verdict({ letter: letter.id })).toEqual({
      state: 'decided',
      verdict: 'allow',
      reason: 'The branch is reviewed',
      by: 'person',
    });
    lines = [];
    await runBridgeAsks({}, person());
    expect(output()).toBe('Nothing waits for you');
  });

  it('keep the inbox file of the bridge: an item while a letter waits, archived once it does not', async () => {
    await startHost();
    await handedOver();
    const { letter } = await leave(await thread());
    const items = (): { id: string; status: string; kind: string }[] =>
      JSON.parse(readFileSync(join(home, BRIDGE_INBOX_FILE), 'utf8'));
    const item = () => items().find((candidate) => candidate.id === inboxItemId(letter.id));

    await vi.waitFor(() => expect(item()).toMatchObject({ kind: 'approval', status: 'unread' }));
    await runBridgeDecide('deny', letter.id, [], {}, person());

    await vi.waitFor(() => expect(item()).toMatchObject({ status: 'archived' }));
    expect(output()).toMatch(/^Refused: codex@\S+ is told\./);
  });

  it('name a letter by its job, its id or the start of its id, and say so when that is not enough', async () => {
    await startHost();
    await handedOver();
    const codexClient = await thread();
    const first = await leave(codexClient, 'git push origin main');
    const second = await leave(codexClient, 'git tag v1');

    expect(await runBridgeDecide('allow', '1', [], {}, person())).toBe(1);
    expect(failed()).toContain('2 letters that wait for you are named 1');
    expect(failed()).toContain(first.letter.id);
    expect(await runBridgeDecide('allow', 'ltr_nothing', [], {}, person())).toBe(1);
    expect(failed()).toContain('Nothing that waits for you is named ltr_nothing');
    lines = [];
    await runBridgeAsks({}, person());
    expect(output()).toContain(`cogitator bridge allow ${second.letter.id}`);

    expect(await runBridgeDecide('deny', second.letter.id.slice(0, 16), [], {}, person())).toBe(0);
    expect(await runBridgeDecide('allow', '#1', [], {}, person())).toBe(0);
  });

  it('are not for agents: a session of one is told so', async () => {
    await startHost();
    await handedOver();
    await leave(await thread());

    expect(await runBridgeDecide('allow', '1', [], {}, claude())).toBe(1);
    expect(await runBridgeAsks({}, codex())).toBe(1);

    expect(failed()).toContain(
      'This runs in a session of claude-code, and an agent does not answer for the person'
    );
    expect(failed()).toContain('This runs in a session of codex');
    lines = [];
    await runBridgeAsks({}, person());
    expect(output()).toContain('Job #1');
  });
});

describe('bridge reply', () => {
  it('answers a question an agent left to the person, and refuses to decide with words', async () => {
    await startHost();
    await handedOver();
    await runBridgeSend(['Which', 'release?'], { job: 1, kind: 'question' }, codex());
    await runBridgeInbox({}, claude());
    lines = [];

    expect(await runBridgeSend([], { job: 1, kind: 'answer', decision: 'person' }, claude())).toBe(
      0
    );
    expect(output()).toMatch(
      /^Left the question ltr_\S+ to the person: their answer goes to codex@\S+$/
    );
    lines = [];
    await runBridgeAsks({}, person());
    expect(output()).toContain('asks:\n  Which release?');
    expect(output()).toContain('Answer: cogitator bridge reply 1 "<your answer>"');
    expect(await runBridgeDecide('allow', '1', [], {}, person())).toBe(1);
    expect(failed()).toContain('takes an answer in words');
    lines = [];

    expect(await runBridgeReply('1', ['The', 'one', 'in', 'March'], {}, person())).toBe(0);

    expect(output()).toMatch(/^Sent to codex@\S+\. Job #1 is working$/);
    lines = [];
    await runBridgeInbox({}, codex());
    expect(output()).toContain('answer from person to codex@');
    expect(output()).toContain('The one in March');
  });

  it('refuses words for a permission request', async () => {
    await startHost();
    await handedOver();
    await leave(await thread());

    expect(await runBridgeReply('1', ['Sure'], {}, person())).toBe(1);
    expect(failed()).toContain('takes a decision');
    expect(failed()).toContain('cogitator bridge allow 1');
  });
});

describe('bridge send --decision', () => {
  it('lets the agent a request was sent to allow or refuse it, with or without a reason', async () => {
    await startHost('allow');
    await handedOver();
    const codexClient = await thread();
    const first = await leave(codexClient, 'git push origin main');

    expect(await runBridgeSend([], { job: 1, kind: 'answer', decision: 'allow' }, claude())).toBe(
      0
    );
    expect(await codexClient.verdict({ letter: first.letter.id })).toMatchObject({
      verdict: 'allow',
      reason: 'Allowed',
    });

    const second = await leave(codexClient, 'git push --force');
    await runBridgeSend(['Never', 'force'], { job: 1, kind: 'answer', decision: 'deny' }, claude());
    expect(await codexClient.verdict({ letter: second.letter.id })).toMatchObject({
      verdict: 'deny',
      reason: 'Never force',
    });

    expect(await runBridgeSend(['x'], { job: 1, kind: 'note', decision: 'allow' }, claude())).toBe(
      1
    );
    expect(failed()).toContain('--decision goes with --kind answer');
  });

  it("passes on what the bridge says when the call is the person's to allow", async () => {
    await startHost('ask');
    await handedOver();
    await leave(await thread());

    expect(await runBridgeSend([], { job: 1, kind: 'answer', decision: 'allow' }, claude())).toBe(
      1
    );
    expect(failed()).toContain("is the person's to allow");
  });
});

describe('how the command line reaches the person', () => {
  const fakeTelegram = () => {
    const state = { started: 0, stopped: 0, tokens: [] as string[] };
    const channel = {
      type: 'telegram',
      start: async () => void (state.started += 1),
      stop: async () => void (state.stopped += 1),
      onMessage: () => undefined,
      onAction: () => undefined,
      sendText: async () => 'm1',
      editText: async () => undefined,
      sendFile: async () => undefined,
      sendTyping: async () => undefined,
    } as Channel;
    return {
      state,
      telegram: (token: string) => {
        state.tokens.push(token);
        return channel;
      },
    };
  };

  it('is the inbox alone by default, and a Telegram chat too when the environment names one', async () => {
    const plain = bridgePerson({ COGITATOR_BRIDGE_HOME: home });
    expect(plain.reachedBy).toEqual(['cogitator bridge asks']);

    const fake = fakeTelegram();
    const withChat = bridgePerson(
      {
        COGITATOR_BRIDGE_HOME: home,
        [BRIDGE_TELEGRAM_TOKEN_ENV]: 'token-1',
        [BRIDGE_TELEGRAM_CHAT_ENV]: ' 4242 ',
        [BRIDGE_TELEGRAM_USERS_ENV]: '7, 8',
      },
      { telegram: fake.telegram }
    );

    expect(withChat.reachedBy).toEqual(['cogitator bridge asks', 'Telegram chat 4242']);
    expect(fake.state.tokens).toEqual(['token-1']);
    await withChat.start();
    await withChat.stop();
    expect(fake.state).toMatchObject({ started: 1, stopped: 1 });
  });

  it('refuses half of a Telegram setup', () => {
    expect(() =>
      bridgePerson({ COGITATOR_BRIDGE_HOME: home, [BRIDGE_TELEGRAM_CHAT_ENV]: '4242' })
    ).toThrow(UsageError);
    expect(() =>
      bridgePerson({ COGITATOR_BRIDGE_HOME: home, [BRIDGE_TELEGRAM_TOKEN_ENV]: 'token-1' })
    ).toThrow(/needs both COGITATOR_BRIDGE_TELEGRAM_TOKEN and COGITATOR_BRIDGE_TELEGRAM_CHAT/);
  });

  it('is started with serve and stopped with it', async () => {
    const fake = fakeTelegram();
    const stop = new AbortController();
    const printed: string[] = [];
    const serving = runBridgeServe(
      {},
      {
        io: { print: (line) => printed.push(line), warn: (line) => printed.push(line) },
        env: { COGITATOR_BRIDGE_HOME: home },
        signal: stop.signal,
        adapters: [],
        person: bridgePerson(
          {
            COGITATOR_BRIDGE_HOME: home,
            [BRIDGE_TELEGRAM_TOKEN_ENV]: 'token-1',
            [BRIDGE_TELEGRAM_CHAT_ENV]: '4242',
          },
          { telegram: fake.telegram }
        ),
      }
    );
    await vi.waitFor(() => expect(fake.state.started).toBe(1));

    stop.abort();

    expect(await serving).toBe(0);
    expect(stripVTControlCharacters(printed.join('\n'))).toContain(
      'What needs you: cogitator bridge asks, Telegram chat 4242'
    );
    expect(fake.state.stopped).toBe(1);
  });
});

describe('journal lines of permission requests', () => {
  const entry = (type: 'letter.queued' | 'letter.escalated', data?: Record<string, unknown>) =>
    describeJournalEntry({
      seq: 1,
      at: '2026-11-17T10:00:00.000Z',
      type,
      agent: 'claude@demo',
      letter: 'ltr_1',
      ...(data && { data }),
    });

  it('say who decides and what was decided', () => {
    expect(
      entry('letter.queued', {
        kind: 'permission',
        from: 'codex@demo',
        to: 'claude@demo',
        body: 'Run `git push`',
        needsPerson: true,
      })
    ).toBe('permission from codex@demo to claude@demo, waits for the person: Run `git push`');
    expect(
      entry('letter.queued', {
        kind: 'answer',
        from: 'person',
        to: 'codex@demo',
        body: 'Allowed by the person',
        verdict: 'allow',
      })
    ).toBe('answer (allow) from person to codex@demo: Allowed by the person');
    expect(entry('letter.escalated')).toBe('claude@demo left ltr_1 to the person');
  });
});
