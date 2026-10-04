import { Agent, tool } from '@cogitator-ai/core';
import { Gateway, createHookRegistry, webchatChannel } from '@cogitator-ai/channels';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type { HookName } from '@cogitator-ai/types';
import { z } from 'zod';
import type { StageDefinition } from '../../runner/types.js';
import { FrameClient, excerpt, until } from './shared.js';

const CHANNELS = '@cogitator-ai/channels';
const CORE = '@cogitator-ai/core';
const MEMORY = '@cogitator-ai/memory';

const TOKEN = `gauntlet-${Math.random().toString(36).slice(2)}`;
const ORDER = 'A-7731';
const CARRIER = 'Kestrel Freight';

interface HookRecord {
  hook: HookName;
  threadId?: string;
  output?: string;
  messageIds?: readonly string[];
}

/** The text a client ends up showing for each message id: the last `message` or `edit` frame wins. */
function shownMessages(client: FrameClient): Map<string, string> {
  const shown = new Map<string, string>();
  for (const frame of client.json) {
    if ((frame.type === 'message' || frame.type === 'edit') && typeof frame.id === 'string') {
      shown.set(frame.id, typeof frame.text === 'string' ? frame.text : '');
    }
    if (frame.type === 'delete' && typeof frame.id === 'string') shown.delete(frame.id);
  }
  return shown;
}

/** Proves a chat UI can talk to an agent over the WebChat channel, with streaming, auth and sessions. */
const webchatStage: StageDefinition = {
  id: 'webchat-channel',
  title: 'WebChat channel',
  description:
    'A Gateway serves an agent over the WebChat WebSocket channel: unauthorized clients are refused, replies stream back as message and edit frames, the agent uses its tool, and the session remembers the conversation.',
  packages: [CHANNELS, CORE, MEMORY],
  needs: ['handshake'],
  timeoutMs: 150_000,
  async run(ctx) {
    let lookups = 0;
    const orderStatus = tool({
      name: 'order_status',
      description: 'Shipping status of a customer order.',
      parameters: z.object({ order: z.string().describe('Order number, e.g. A-1234') }),
      execute: async ({ order }) => {
        lookups++;
        return order.toUpperCase() === ORDER
          ? { order: ORDER, status: 'shipped', carrier: CARRIER, eta: '2026-10-09' }
          : { order, status: 'unknown' };
      },
    });
    const agent = new Agent({
      name: 'support-desk',
      model: ctx.model,
      instructions:
        'You are a shop support agent. Look orders up with order_status before answering. Keep replies to two sentences.',
      tools: [orderStatus],
      maxIterations: 4,
    });

    const hooks = createHookRegistry();
    const seen: HookRecord[] = [];
    for (const hook of [
      'message:received',
      'session:created',
      'agent:after_run',
      'agent:error',
    ] as const) {
      hooks.on(hook, (event) => {
        seen.push({
          hook,
          ...('threadId' in event ? { threadId: event.threadId } : {}),
          ...('output' in event ? { output: event.output } : {}),
        });
      });
    }
    hooks.on('stream:finished', (event) => {
      seen.push({
        hook: 'stream:finished',
        threadId: event.threadId,
        messageIds: event.messageIds,
      });
    });

    const port = await ctx.freePort();
    const errors: string[] = [];
    const gateway = new Gateway({
      cogitator: ctx.createCogitator({ memory: { adapter: 'memory' } }),
      agent,
      channels: [webchatChannel({ port, path: '/chat', auth: (token) => token === TOKEN })],
      memory: new InMemoryAdapter(),
      hooks,
      stream: { flushInterval: 150, minChunkSize: 8 },
      queueMode: 'sequential',
      onError: (error) => errors.push(error.message),
    });
    await gateway.start();
    ctx.onCleanup(() => gateway.stop());
    const url = `ws://127.0.0.1:${port}/chat`;

    await ctx.check('unauthorized clients are refused', async (evidence) => {
      const intruder = await FrameClient.connect(`${url}?token=wrong`);
      await intruder.waitFor(
        (client) => client.closeCode !== undefined,
        5_000,
        'the server to close'
      );
      evidence('frames', intruder.json);
      evidence('closeCode', intruder.closeCode);
      if (
        !intruder.json.some((frame) => frame.type === 'error' && frame.message === 'unauthorized')
      ) {
        throw new Error('No unauthorized error frame');
      }
      if (intruder.closeCode !== 1008) {
        throw new Error(`Closed with ${intruder.closeCode}, expected 1008`);
      }
    });

    const client = await FrameClient.connect(`${url}?token=${TOKEN}`);
    ctx.onCleanup(() => client.close());

    const clientId = await ctx.check('an authorized client connects', async (evidence) => {
      await client.waitFor(
        (c) => c.json.some((frame) => frame.type === 'connected'),
        5_000,
        'connected'
      );
      const connected = client.json.find((frame) => frame.type === 'connected');
      evidence('clientId', connected?.clientId);
      evidence('stats', gateway.stats);
      if (typeof connected?.clientId !== 'string') {
        throw new Error('The connected frame has no clientId');
      }
      if (!gateway.stats.connectedChannels.includes('webchat')) {
        throw new Error('webchat is not a connected channel');
      }
      return connected.clientId;
    });
    const threadId = `webchat:${clientId}`;

    const turn = async (text: string, id: string, turnNumber: number) => {
      client.sendJson({ text, id });
      await until(
        () =>
          seen.filter((record) => record.hook === 'stream:finished' && record.threadId === threadId)
            .length >= turnNumber || errors.length > 0,
        90_000,
        `turn ${turnNumber} to finish`,
        ctx.signal
      );
      if (errors.length > 0) throw new Error(`The gateway reported: ${errors.join('; ')}`);
      const finished = seen.filter(
        (record) => record.hook === 'stream:finished' && record.threadId === threadId
      );
      const ids = finished[turnNumber - 1]?.messageIds ?? [];
      await client.waitFor(
        (c) => ids.length > 0 && ids.every((messageId) => shownMessages(c).has(messageId)),
        5_000,
        'the streamed frames'
      );
      const shown = shownMessages(client);
      return { ids, text: ids.map((messageId) => shown.get(messageId) ?? '').join('\n') };
    };

    await ctx.check('the reply streams back after a tool call', async (evidence) => {
      const reply = await turn(
        `Where is my order ${ORDER}? Which carrier has it?`,
        'question-1',
        1
      );
      const frames = client.json.map((frame) => frame.type);
      evidence('frameTypes', [...new Set(frames)]);
      evidence('edits', frames.filter((type) => type === 'edit').length);
      evidence('lookups', lookups);
      evidence('reply', excerpt(reply.text, 200));
      const first = client.json.find((frame) => frame.type === 'message');
      if (first?.replyTo !== 'question-1') {
        throw new Error('The reply does not point at the question');
      }
      if (!frames.includes('typing')) throw new Error('No typing indicator was sent');
      if (lookups === 0) throw new Error('The agent answered without order_status');
      if (!reply.text.includes('Kestrel')) {
        throw new Error('The streamed reply does not name the carrier the tool returned');
      }
    });

    await ctx.check('the session remembers the conversation', async (evidence) => {
      const reply = await turn(
        'Which order number did I ask about? Answer with the number only.',
        'question-2',
        2
      );
      const session = gateway.getSessions().find((entry) => entry.threadId === threadId);
      evidence('reply', excerpt(reply.text, 120));
      evidence('session', session);
      evidence(
        'sessionsCreated',
        seen.filter((record) => record.hook === 'session:created').length
      );
      if (!reply.text.includes(ORDER)) {
        throw new Error('The second turn did not recall the order number');
      }
      if (session?.messageCount !== 2) {
        throw new Error(`The session counts ${session?.messageCount} messages, expected 2`);
      }
      if (seen.filter((record) => record.hook === 'session:created').length !== 1) {
        throw new Error('Expected exactly one session:created hook');
      }
    });
  },
};

export const channelStages: StageDefinition[] = [webchatStage];
