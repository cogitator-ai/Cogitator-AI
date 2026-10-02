import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import {
  Gateway,
  HeartbeatScheduler,
  SimpleTimerStore,
  createHookRegistry,
  getNextCronMs,
  webchatChannel,
} from '@cogitator-ai/channels';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type { Cogitator } from '@cogitator-ai/core';
import type { Channel, ChannelMessage } from '@cogitator-ai/types';
import { createTestAgent, createTestCogitator, isOllamaRunning } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

interface RecordingChannel extends Channel {
  trigger(msg: ChannelMessage): Promise<void>;
  rendered: Map<string, string>;
  sent: string[];
}

function recordingChannel(type = 'test'): RecordingChannel {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  let counter = 0;
  const rendered = new Map<string, string>();
  const sent: string[] = [];
  return {
    type,
    rendered,
    sent,
    start: async () => {},
    stop: async () => {},
    onMessage: (h) => {
      handler = h;
    },
    sendText: async (_channelId, text) => {
      const id = `out_${++counter}`;
      rendered.set(id, text);
      sent.push(text);
      return id;
    },
    editText: async (_channelId, messageId, text) => {
      rendered.set(messageId, text);
    },
    sendFile: async () => {},
    sendTyping: async () => {},
    trigger: async (msg) => {
      if (handler) await handler(msg);
    },
  };
}

function message(text: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `in_${Math.random().toString(36).slice(2)}`,
    channelType: 'test',
    channelId: 'chat_1',
    userId: 'user_1',
    userName: 'Tester',
    text,
    raw: {},
    ...overrides,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

describeE2E('Channels E2E: Live LLM through Gateway', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('answers a WebChat client over a real WebSocket', async () => {
    const port = await freePort();
    const channel = webchatChannel({ port, auth: (token) => token === 'secret' });
    const errors: Error[] = [];
    const gateway = new Gateway({
      agent: createTestAgent({
        instructions: 'You are a math assistant. Reply with ONLY the number, nothing else.',
      }),
      cogitator,
      channels: [channel],
      onError: (err) => errors.push(err),
    });
    await gateway.start();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=secret`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    await vi.waitFor(() => expect(frames.some((f) => f.type === 'connected')).toBe(true));
    ws.send(JSON.stringify({ id: 'q1', text: 'What is 2+2? Reply with ONLY the number.' }));

    await vi.waitFor(
      () => {
        expect(frames.find((f) => f.type === 'message')).toBeDefined();
      },
      { timeout: 90_000, interval: 200 }
    );

    const reply = frames.find((f) => f.type === 'message')!;
    expect(String(reply.text)).toMatch(/4/);
    expect(reply.replyTo).toBe('q1');
    expect(errors).toEqual([]);

    ws.close();
    await gateway.stop();
  });

  it('streams tokens into a single message that ends with the full answer', async () => {
    const channel = recordingChannel();
    const hooks = createHookRegistry();
    const finished = vi.fn();
    hooks.on('stream:finished', finished);

    const gateway = new Gateway({
      agent: createTestAgent({
        instructions: 'You are a helpful assistant. Answer in one short sentence.',
      }),
      cogitator,
      channels: [channel],
      stream: { flushInterval: 100, minChunkSize: 1 },
      hooks,
    });
    await gateway.start();

    await channel.trigger(message('Name the capital of France in one short sentence.'));

    expect(finished).toHaveBeenCalledTimes(1);
    const ids = (finished.mock.calls[0][0] as { messageIds: string[] }).messageIds;
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const finalText = ids.map((id) => channel.rendered.get(id) ?? '').join(' ');
    expect(finalText.trim().length).toBeGreaterThan(0);
    expect(finalText).toMatch(/paris/i);

    await gateway.stop();
  });

  it('compacts long conversations with an LLM-written summary', async () => {
    const memory = new InMemoryAdapter({ provider: 'memory' });
    await memory.connect();
    cogitator.memory = memory;

    const channel = recordingChannel();
    const hooks = createHookRegistry();
    const compacted = vi.fn();
    hooks.on('session:compacted', compacted);

    const gateway = new Gateway({
      agent: createTestAgent({ instructions: 'You are a friendly assistant. Reply briefly.' }),
      cogitator,
      channels: [channel],
      memory,
      hooks,
      session: { compaction: { strategy: 'summary', threshold: 4, keepRecent: 2 } },
    });
    await gateway.start();

    await channel.trigger(message('My name is Alice and my favourite colour is green.'));
    await channel.trigger(message('I live in Berlin and I work as a nurse.'));
    await channel.trigger(message('What is my name?'));

    expect(compacted).toHaveBeenCalled();
    const entries = await memory.getEntries({ threadId: 'test:user_1' });
    expect(entries.success).toBe(true);
    const summary = entries.success
      ? entries.data.find((e) => e.metadata?.compactionSummary === true)
      : undefined;
    expect(summary).toBeDefined();
    expect(String(summary?.message.content)).toContain('[Conversation summary]');
    expect(String(summary?.message.content).length).toBeGreaterThan(
      '[Conversation summary]'.length + 5
    );
    expect(channel.sent).toHaveLength(3);

    await gateway.stop();
    cogitator.memory = undefined;
    await memory.disconnect();
  });

  it('delivers a scheduled task through the heartbeat scheduler', async () => {
    const channel = recordingChannel('telegram');
    const errors: Error[] = [];
    const gateway = new Gateway({
      agent: createTestAgent({ instructions: 'You are a reminder assistant. Reply briefly.' }),
      cogitator,
      channels: [channel],
      onError: (err) => errors.push(err),
    });
    await gateway.start();

    const store = new SimpleTimerStore({
      resolveCronFiresAt: (cron, tz) => getNextCronMs(cron, Date.now(), tz),
    });
    await store.schedule({
      workflowId: 'heartbeat',
      runId: 'scheduler',
      nodeId: 'task',
      firesAt: Date.now() - 1,
      type: 'fixed',
      metadata: { description: 'Remind me to drink water', channel: 'telegram', userId: 'user_1' },
    });
    const cronId = await store.schedule({
      workflowId: 'heartbeat',
      runId: 'scheduler',
      nodeId: 'task',
      firesAt: 0,
      type: 'cron',
      cron: '0 9 * * *',
      metadata: { description: 'Morning briefing', channel: 'telegram', userId: 'user_1' },
    });
    const cronEntry = await store.get(cronId);
    expect(cronEntry!.firesAt).toBeGreaterThan(Date.now());

    const scheduler = new HeartbeatScheduler(store, {
      onFire: (msg) => gateway.injectMessage(msg),
      pollInterval: 100,
    });
    scheduler.start();

    await vi.waitFor(() => expect(channel.sent.length).toBe(1), {
      timeout: 90_000,
      interval: 200,
    });
    scheduler.stop();

    expect(channel.sent[0].trim().length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect((await store.getOverdue()).length).toBe(0);

    await gateway.stop();
  });
});
