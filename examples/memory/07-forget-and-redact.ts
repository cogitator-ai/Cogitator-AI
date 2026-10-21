import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { isMemoryItemAdapter, MemoryItems } from '@cogitator-ai/memory';

async function main() {
  header('07 - Forget and Redact');

  const cog = createCogitator({
    memory: {
      adapter: 'memory',
      contextBuilder: { strategy: 'recent', maxTokens: 4000, includeFacts: true },
      extraction: {},
    },
  });
  const assistant = new Agent({
    name: 'assistant',
    model: DEFAULT_MODEL,
    instructions: 'You are a helpful assistant. Answer in one sentence.',
    temperature: 0,
  });
  const memory = await cog.getMemory();
  if (!memory || !isMemoryItemAdapter(memory)) throw new Error('This memory keeps no items');
  const items = new MemoryItems({ adapter: memory });
  const facts = async () =>
    (await items.query({ scope: { agentId: 'assistant', userId: 'ana' } })).map(
      (item) => item.content
    );

  section('1. A conversation memory learns from');

  for (const input of [
    'My locker code at the gym is 8812.',
    'My passport number is X91-4471, I need it for the visa form.',
    'I live in Porto.',
  ]) {
    await cog.run(assistant, { input, threadId: 'chat', userId: 'ana' });
  }
  console.log('What memory keeps:', await facts());

  const turns = await memory.getEntries({ threadId: 'chat' });
  if (!turns.success) throw new Error(turns.error);
  const turnOf = (words: string) =>
    turns.data.find(
      (entry) =>
        entry.message.role === 'user' &&
        typeof entry.message.content === 'string' &&
        entry.message.content.includes(words)
    );

  section('2. Forget a turn: it goes, with everything memory made of it');

  const locker = turnOf('locker');
  if (locker) {
    const report = await cog.forget({ entryIds: [locker.id] }, { agents: [assistant] });
    console.log('Deleted entries:', report.entries.deleted.length);
    console.log('Items purged:', report.items.purged.length);
  }
  console.log('What memory keeps:', await facts());

  section('3. Redact a turn: it keeps its place, nothing of what it said');

  const passport = turnOf('passport');
  if (passport) {
    const report = await cog.redactEntries([passport.id], {
      agents: [assistant],
      reason: 'the user asked',
    });
    console.log('Redacted entries:', report.entries.redacted.length);
    const entry = await memory.getEntry(passport.id);
    console.log('The turn now says:', entry.success ? entry.data?.message.content : '?');
  }
  console.log('What memory keeps:', await facts());

  section('4. Ask again');

  const answer = await cog.run(assistant, {
    input: 'What do you know about me?',
    threadId: 'chat',
    userId: 'ana',
  });
  console.log('Assistant:', answer.output);

  section('5. Forget the user');

  const report = await cog.forget({ userId: 'ana' }, { agents: [assistant] });
  console.log('Threads deleted:', report.threads);
  console.log('What memory keeps:', await facts());

  await cog.close();
  console.log('\nDone.');
}

main();
