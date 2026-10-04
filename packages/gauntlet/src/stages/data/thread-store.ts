import { unwrap } from '@cogitator-ai/memory';
import type { MemoryAdapter, MemoryEntry, Message, ToolCall } from '@cogitator-ai/types';
import type { StageContext } from '../../runner/types.js';
import { textOf, uniqueSuffix } from './support.js';

/** The conversation every store writes, in this order. */
const CONVERSATION: Array<{ message: Message; toolCalls?: ToolCall[] }> = [
  { message: { role: 'user', content: 'Book a table for two at Quillon on Friday.' } },
  {
    message: { role: 'assistant', content: '' },
    toolCalls: [{ id: 'call_1', name: 'book_table', arguments: { venue: 'Quillon', guests: 2 } }],
  },
  {
    message: {
      role: 'tool',
      content: '{"confirmation":"QX-5521"}',
      toolCallId: 'call_1',
      name: 'book_table',
    },
  },
  { message: { role: 'assistant', content: 'Booked, your confirmation is QX-5521.' } },
  { message: { role: 'user', content: 'Thanks, add a reminder an hour before.' } },
];

export interface ThreadStoreReport {
  threadId: string;
  entryIds: string[];
}

/**
 * The thread lifecycle every `MemoryAdapter` promises, run against one connected adapter: create,
 * upsert, metadata merge, append in order, windowed and bounded reads, tool calls on demand,
 * single-entry reads, deletes. Each step is a check named after the store.
 */
export async function exerciseThreadStore(
  ctx: StageContext,
  store: string,
  adapter: MemoryAdapter,
  options: { keepThread?: boolean } = {}
): Promise<ThreadStoreReport> {
  const agentId = `gauntlet-data-${uniqueSuffix()}`;
  const threadId = `thread_${store}_${uniqueSuffix()}`;

  const created = await ctx.check(
    `${store}: creates a thread under a caller-chosen id`,
    async (evidence) => {
      const thread = unwrap(await adapter.createThread(agentId, { topic: 'dinner' }, threadId));
      evidence('threadId', thread.id);
      evidence('provider', adapter.provider);
      if (thread.id !== threadId) throw new Error(`Thread id ${thread.id}, expected ${threadId}`);
      const read = unwrap(await adapter.getThread(threadId));
      if (!read) throw new Error('getThread returned null right after createThread');
      if (read.agentId !== agentId) throw new Error(`agentId came back as ${read.agentId}`);
      if (read.metadata.topic !== 'dinner') {
        throw new Error(`Metadata came back as ${JSON.stringify(read.metadata)}`);
      }
      return read;
    }
  );

  const entries = await ctx.check(
    `${store}: appends entries and reads them back in order`,
    async (evidence) => {
      const written: MemoryEntry[] = [];
      for (const { message, toolCalls } of CONVERSATION) {
        written.push(
          unwrap(
            await adapter.addEntry({
              threadId,
              message,
              ...(toolCalls && { toolCalls }),
              tokenCount: textOf(message.content).length,
            })
          )
        );
      }
      const read = unwrap(await adapter.getEntries({ threadId }));
      evidence('written', written.length);
      evidence('read', read.length);
      evidence(
        'roles',
        read.map((entry) => entry.message.role)
      );
      if (read.length !== CONVERSATION.length) {
        throw new Error(`Read ${read.length} entries, wrote ${CONVERSATION.length}`);
      }
      const order = read.map((entry) => entry.id);
      const expected = written.map((entry) => entry.id);
      if (order.join() !== expected.join()) {
        throw new Error(`Entries came back out of order: ${order.join(', ')}`);
      }
      const lastText = textOf(read.at(-1)?.message.content);
      if (!lastText.includes('reminder')) throw new Error(`Last entry reads "${lastText}"`);
      const tool = read[2]?.message;
      if (tool?.toolCallId !== 'call_1' || tool.name !== 'book_table') {
        throw new Error(`The tool message lost its toolCallId or name: ${JSON.stringify(tool)}`);
      }
      return written;
    }
  );

  await ctx.check(`${store}: limit returns the newest entries, oldest first`, async (evidence) => {
    const window = unwrap(await adapter.getEntries({ threadId, limit: 2 }));
    evidence(
      'ids',
      window.map((entry) => entry.id)
    );
    const expected = entries.slice(-2).map((entry) => entry.id);
    if (window.map((entry) => entry.id).join() !== expected.join()) {
      throw new Error(
        `limit 2 returned ${window.map((entry) => entry.id).join(', ')}, expected ${expected.join(', ')}`
      );
    }
  });

  await ctx.check(`${store}: after bound and tool calls on demand`, async (evidence) => {
    const pivot = entries[1]!;
    const later = unwrap(await adapter.getEntries({ threadId, after: pivot.createdAt }));
    evidence('afterCount', later.length);
    if (later.length !== entries.length - 2) {
      throw new Error(
        `after the second entry returned ${later.length} entries, expected ${entries.length - 2}`
      );
    }
    const plain = unwrap(await adapter.getEntries({ threadId }));
    const withCalls = unwrap(await adapter.getEntries({ threadId, includeToolCalls: true }));
    const call = withCalls[1]?.toolCalls?.[0];
    evidence('toolCall', call?.name);
    if (call?.name !== 'book_table' || call.arguments.guests !== 2) {
      throw new Error(`includeToolCalls returned ${JSON.stringify(withCalls[1]?.toolCalls)}`);
    }
    if (plain[1]?.toolCalls) throw new Error('Tool calls came back without includeToolCalls');
    const single = unwrap(await adapter.getEntry(pivot.id));
    if (single?.id !== pivot.id) throw new Error(`getEntry(${pivot.id}) returned ${single?.id}`);
  });

  await ctx.check(
    `${store}: createThread on an existing id keeps entries, updateThread merges`,
    async (evidence) => {
      unwrap(await adapter.createThread(agentId, { topic: 'dinner', channel: 'web' }, threadId));
      unwrap(await adapter.updateThread(threadId, { resolved: true }));
      const thread = unwrap(await adapter.getThread(threadId));
      const kept = unwrap(await adapter.getEntries({ threadId }));
      evidence('metadata', thread?.metadata);
      evidence('entriesKept', kept.length);
      if (kept.length !== entries.length) {
        throw new Error(`The upsert left ${kept.length} of ${entries.length} entries`);
      }
      if (thread?.metadata.channel !== 'web' || thread.metadata.resolved !== true) {
        throw new Error(`Metadata after upsert and update: ${JSON.stringify(thread?.metadata)}`);
      }
      if (thread.createdAt.getTime() !== created.createdAt.getTime()) {
        throw new Error(
          `The upsert moved createdAt from ${created.createdAt.toISOString()} to ${thread.createdAt.toISOString()}`
        );
      }
    }
  );

  await ctx.check(`${store}: deletes an entry`, async (evidence) => {
    const victim = entries[0]!;
    unwrap(await adapter.deleteEntry(victim.id));
    const gone = unwrap(await adapter.getEntry(victim.id));
    const rest = unwrap(await adapter.getEntries({ threadId }));
    evidence('remaining', rest.length);
    if (gone) throw new Error('getEntry still finds the deleted entry');
    if (rest.some((entry) => entry.id === victim.id))
      throw new Error('getEntries still lists the deleted entry');
  });

  if (!options.keepThread) {
    await ctx.check(`${store}: deletes the thread with its entries`, async (evidence) => {
      unwrap(await adapter.deleteThread(threadId));
      const thread = unwrap(await adapter.getThread(threadId));
      const rest = unwrap(await adapter.getEntries({ threadId }));
      const orphan = unwrap(await adapter.getEntry(entries.at(-1)!.id));
      evidence('thread', thread);
      evidence('entries', rest.length);
      if (thread) throw new Error('getThread still finds the deleted thread');
      if (rest.length > 0) throw new Error(`${rest.length} entries survived deleteThread`);
      if (orphan) throw new Error('getEntry still finds an entry of the deleted thread');
    });
  }

  return { threadId, entryIds: entries.map((entry) => entry.id) };
}
