import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PairingMiddleware } from '../middleware/pairing';
import { RateLimitMiddleware } from '../middleware/rate-limit';
import { OwnerCommandsMiddleware } from '../middleware/owner-commands';
import { DmPolicyMiddleware } from '../middleware/dm-policy';
import { AutoExtractMiddleware } from '../middleware/auto-extract';
import { createSelfConfigTools } from '../tools/self-config';
import type { ChannelMessage, MiddlewareContext, Channel, ToolContext } from '@cogitator-ai/types';

function createMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg_1',
    channelType: 'telegram',
    channelId: 'ch_1',
    userId: 'user_1',
    text: 'Hello',
    raw: {},
    ...overrides,
  };
}

function createCtx(): MiddlewareContext & { channel: { sendText: ReturnType<typeof vi.fn> } } {
  const store = new Map<string, unknown>();
  return {
    threadId: 'thread_1',
    user: { id: 'user_1', channelType: 'telegram' },
    channel: {
      type: 'telegram',
      start: vi.fn(),
      stop: vi.fn(),
      onMessage: vi.fn(),
      sendText: vi.fn().mockResolvedValue('sent_1'),
      editText: vi.fn(),
      sendFile: vi.fn(),
      sendTyping: vi.fn(),
    } as Channel & { sendText: ReturnType<typeof vi.fn> },
    set: (k: string, v: unknown) => store.set(k, v),
    get: <T>(k: string) => store.get(k) as T | undefined,
  };
}

function codeFrom(ctx: ReturnType<typeof createCtx>): string {
  const text = ctx.channel.sendText.mock.calls.at(-1)?.[1] as string;
  return /`\/pair (\S+)`/.exec(text)?.[1] ?? '';
}

describe('PairingMiddleware security', () => {
  it('paired non-owner users cannot approve others', async () => {
    const mw = new PairingMiddleware({ ownerIds: { telegram: 'owner' } });

    const aliceCtx = createCtx();
    await mw.handle(createMsg({ userId: 'alice' }), aliceCtx, vi.fn());
    await mw.handle(
      createMsg({ userId: 'owner', text: `/pair ${codeFrom(aliceCtx)}` }),
      createCtx(),
      vi.fn()
    );
    expect(mw.isApproved('telegram', 'alice')).toBe(true);

    const malloryCtx = createCtx();
    await mw.handle(createMsg({ userId: 'mallory' }), malloryCtx, vi.fn());
    const next = vi.fn();
    await mw.handle(
      createMsg({ userId: 'alice', text: `/pair ${codeFrom(malloryCtx)}` }),
      createCtx(),
      next
    );

    expect(mw.isApproved('telegram', 'mallory')).toBe(false);
    expect(next).toHaveBeenCalled();
  });

  it('generates codes without ambiguous characters and accepts /pair@bot', async () => {
    const mw = new PairingMiddleware({ ownerIds: { telegram: 'owner' }, codeLength: 12 });
    const ctx = createCtx();
    await mw.handle(createMsg({ userId: 'bob' }), ctx, vi.fn());
    const code = codeFrom(ctx);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);

    await mw.handle(
      createMsg({ userId: 'owner', text: `/pair@my_bot ${code.toLowerCase()}` }),
      createCtx(),
      vi.fn()
    );
    expect(mw.isApproved('telegram', 'bob')).toBe(true);
  });

  it('expired codes are rejected', async () => {
    vi.useFakeTimers();
    try {
      const mw = new PairingMiddleware({ ownerIds: { telegram: 'owner' }, expiresIn: 1 });
      const ctx = createCtx();
      await mw.handle(createMsg({ userId: 'bob' }), ctx, vi.fn());
      vi.advanceTimersByTime(2000);

      const ownerCtx = createCtx();
      await mw.handle(
        createMsg({ userId: 'owner', text: `/pair ${codeFrom(ctx)}` }),
        ownerCtx,
        vi.fn()
      );
      expect(ownerCtx.channel.sendText).toHaveBeenCalledWith(
        'ch_1',
        'Invalid or expired pairing code.'
      );
      expect(mw.isApproved('telegram', 'bob')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RateLimitMiddleware notices', () => {
  it('sends the limit notice only once per window', async () => {
    const mw = new RateLimitMiddleware({ maxPerMinute: 1 });
    const ctx = createCtx();
    for (let i = 0; i < 5; i++) await mw.handle(createMsg(), ctx, vi.fn());
    expect(ctx.channel.sendText).toHaveBeenCalledTimes(1);
  });

  it('lets users through again after the window', async () => {
    vi.useFakeTimers();
    try {
      const mw = new RateLimitMiddleware({ maxPerMinute: 1 });
      const next = vi.fn();
      await mw.handle(createMsg(), createCtx(), next);
      await mw.handle(createMsg(), createCtx(), next);
      vi.advanceTimersByTime(61_000);
      await mw.handle(createMsg(), createCtx(), next);
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OwnerCommandsMiddleware parsing', () => {
  it('recognizes /command@botname from Telegram groups', async () => {
    const onStatus = vi.fn().mockReturnValue('ok');
    const mw = new OwnerCommandsMiddleware({ ownerIds: { telegram: 'owner' }, onStatus });
    const ctx = createCtx();
    await mw.handle(createMsg({ userId: 'owner', text: '/status@my_bot' }), ctx, vi.fn());
    expect(onStatus).toHaveBeenCalled();
  });

  it('passes multi-line arguments to handlers', async () => {
    const onModel = vi.fn().mockReturnValue('done');
    const mw = new OwnerCommandsMiddleware({ ownerIds: { telegram: 'owner' }, onModel });
    await mw.handle(
      createMsg({ userId: 'owner', text: '/model\ngpt-4o @alice' }),
      createCtx(),
      vi.fn()
    );
    expect(onModel).toHaveBeenCalledWith('gpt-4o', '@alice');
  });

  it('does not treat prototype keys as commands', async () => {
    const mw = new OwnerCommandsMiddleware({ ownerIds: { telegram: 'owner' } });
    const next = vi.fn();
    await mw.handle(createMsg({ userId: 'owner', text: '/constructor' }), createCtx(), next);
    expect(next).toHaveBeenCalled();
  });
});

describe('DmPolicyMiddleware persistence', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reports store write failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'blocker'), 'file');
    const onStoreError = vi.fn();
    const mw = new DmPolicyMiddleware({
      mode: 'pairing',
      ownerIds: { telegram: 'owner' },
      storePath: join(dir, 'blocker', 'store.json'),
      onStoreError,
    });

    const ctx = createCtx();
    await mw.handle(createMsg({ userId: 'bob' }), ctx, vi.fn());
    await mw.handle(
      createMsg({ userId: 'owner', text: `/pair ${codeFrom(ctx)}` }),
      createCtx(),
      vi.fn()
    );

    expect(onStoreError).toHaveBeenCalled();
    expect(mw.isApproved('telegram', 'bob')).toBe(true);
  });
});

describe('AutoExtractMiddleware graph hygiene', () => {
  function graph() {
    return {
      addNode: vi
        .fn()
        .mockResolvedValueOnce({ success: true, data: { id: 'n1' } })
        .mockResolvedValueOnce({ success: true, data: { id: 'n2' } }),
      getNodeByName: vi.fn().mockResolvedValue({ success: true, data: null }),
      updateNode: vi.fn().mockResolvedValue({ success: true }),
      addEdge: vi.fn().mockResolvedValue({ success: true }),
      updateEdge: vi.fn().mockResolvedValue({ success: true }),
      getEdgesBetween: vi.fn().mockResolvedValue({ success: true, data: [] }),
    };
  }

  it('maps unknown types to custom and keeps the original label', async () => {
    const g = graph();
    const mw = new AutoExtractMiddleware({
      extractor: {
        extract: vi.fn().mockResolvedValue({
          entities: [
            { name: 'Alice', type: 'Person', confidence: 0.9 },
            { name: 'Berlin', type: 'city', confidence: 0.8 },
          ],
          relations: [{ from: 'Alice', to: 'Berlin', type: 'lives_in', confidence: 0.7 }],
        }),
      },
      graphAdapter: g as never,
      agentId: 'a',
    });
    await mw.handle(createMsg({ text: 'Alice lives in Berlin' }), createCtx(), vi.fn());

    await vi.waitFor(() => expect(g.addEdge).toHaveBeenCalled());
    expect(g.addNode.mock.calls[0][0].type).toBe('person');
    expect(g.addNode.mock.calls[1][0]).toEqual(
      expect.objectContaining({ type: 'custom', properties: { originalType: 'city' } })
    );
    expect(g.addEdge.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: 'custom', label: 'lives_in', sourceNodeId: 'n1' })
    );
  });

  it('does not duplicate existing edges', async () => {
    const g = graph();
    g.getEdgesBetween.mockResolvedValue({
      success: true,
      data: [{ id: 'e1', type: 'knows', label: undefined, confidence: 0.5 }],
    });
    const mw = new AutoExtractMiddleware({
      extractor: {
        extract: vi.fn().mockResolvedValue({
          entities: [
            { name: 'A', type: 'person', confidence: 0.9 },
            { name: 'B', type: 'person', confidence: 0.9 },
          ],
          relations: [{ from: 'A', to: 'B', type: 'knows', confidence: 0.9 }],
        }),
      },
      graphAdapter: g as never,
      agentId: 'a',
    });
    await mw.handle(createMsg({ text: 'A knows B' }), createCtx(), vi.fn());

    await vi.waitFor(() => expect(g.updateEdge).toHaveBeenCalledWith('e1', { confidence: 0.9 }));
    expect(g.addEdge).not.toHaveBeenCalled();
  });

  it('does not erase descriptions and reuses global regex patterns safely', async () => {
    const g = graph();
    g.getNodeByName.mockResolvedValue({ success: true, data: { id: 'n1', confidence: 0.1 } });
    const set = vi.fn().mockResolvedValue(undefined);
    const mw = new AutoExtractMiddleware({
      extractor: {
        extract: vi.fn().mockResolvedValue({
          entities: [{ name: 'X', type: 'concept', confidence: 0.9 }],
          relations: [],
        }),
      },
      graphAdapter: g as never,
      agentId: 'a',
      coreFacts: { set },
      coreFactPatterns: { name: /my name is (\w+)/gi },
    });

    await mw.handle(createMsg({ text: 'my name is Ann' }), createCtx(), vi.fn());
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    await mw.handle(createMsg({ text: 'my name is Bob' }), createCtx(), vi.fn());
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));

    expect(set).toHaveBeenLastCalledWith('name', 'Bob');
    expect(g.updateNode.mock.calls[0][1]).not.toHaveProperty('description');
  });
});

describe('createSelfConfigTools security', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(authorize?: (c: { userId?: string; channelType?: string }) => boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'selfcfg-'));
    dirs.push(dir);
    const configPath = join(dir, 'cogitator.yml');
    writeFileSync(configPath, JSON.stringify({ name: 'bot' }));
    const tools = createSelfConfigTools({
      configPath,
      parseYaml: (s) => JSON.parse(s),
      stringifyYaml: (o) => JSON.stringify(o),
      validateConfig: (o) => o,
      authorize,
    });
    const get = (name: string) => tools.find((t) => t.name === name)!;
    return { dir, configPath, get };
  }

  const ctx = (userId: string, channelType = 'telegram') =>
    ({
      agentId: 'a',
      runId: 'r',
      signal: new AbortController().signal,
      userId,
      channelType,
    }) as ToolContext;

  it('denies unauthorized callers for every tool', async () => {
    const { get, configPath } = setup((c) => c.userId === 'owner');
    for (const name of ['config_read', 'config_update', 'env_check', 'env_set']) {
      const result = (await get(name).execute(
        name === 'config_update'
          ? { updates: { name: 'pwned' } }
          : name === 'env_set'
            ? { vars: { A: 'b' } }
            : {},
        ctx('mallory')
      )) as { success: boolean };
      expect(result.success).toBe(false);
    }
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).name).toBe('bot');
  });

  it('allows authorized callers', async () => {
    const { get } = setup((c) => c.userId === 'owner');
    const result = (await get('config_read').execute({}, ctx('owner'))) as {
      config: { name: string };
    };
    expect(result.config.name).toBe('bot');
  });

  it('env_set preserves comments and rejects newline injection', async () => {
    const { get, dir } = setup();
    const envPath = join(dir, '.env');
    writeFileSync(envPath, '# keys\nexport FOO=old\n\nBAR=keep\n');

    const ok = (await get('env_set').execute(
      { vars: { FOO: 'new value', NEW_KEY: 'x' } },
      ctx('owner')
    )) as { success: boolean };
    expect(ok.success).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toBe('# keys\nFOO="new value"\n\nBAR=keep\nNEW_KEY=x\n');

    const bad = (await get('env_set').execute({ vars: { FOO: 'x\nEVIL=1' } }, ctx('owner'))) as {
      success: boolean;
    };
    expect(bad.success).toBe(false);

    const fresh = setup();
    await get('env_set').execute({ vars: { X: '1' } }, ctx('owner'));
    await fresh.get('env_set').execute({ vars: { SECRET: 'abc' } }, ctx('owner'));
    expect(statSync(join(fresh.dir, '.env')).mode & 0o077).toBe(0);

    const badKey = (await get('env_set').execute({ vars: { 'A B': 'x' } }, ctx('owner'))) as {
      success: boolean;
    };
    expect(badKey.success).toBe(false);
  });
});
