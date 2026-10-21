import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, memoryAgentId, memoryCitations } from '@cogitator-ai/core';
import { countTokens, isMemoryFileAdapter, MemoryFiles, unwrap } from '@cogitator-ai/memory';

async function main() {
  header('05 - Memory Files and Memory Search Tools');

  const uncited: string[][] = [];
  const cog = createCogitator({
    memory: {
      adapter: 'memory',
      contextBuilder: { strategy: 'recent', maxTokens: 600 },
      files: { scope: 'user' },
    },
    middleware: [memoryCitations({ onUncited: (references) => uncited.push(references) })],
  });

  section('1. The memory tool: notes kept across conversations');

  const notetaker = new Agent({
    name: 'notetaker',
    model: DEFAULT_MODEL,
    instructions:
      'You keep notes about the user in your memory directory with the memory tool. When the user tells you something worth remembering, write it to /memories/user.md. Before you give advice, view your notes. Be concise.',
    temperature: 0.2,
  });

  const first = await cog.run(notetaker, {
    input: 'Please remember: I am allergic to peanuts and I prefer trains to planes.',
    userId: 'ana',
    threadId: 'notes-1',
  });
  console.log('Assistant:', first.output);
  console.log(
    'Memory tool calls:',
    first.toolCalls.filter((call) => call.name === 'memory').map((call) => call.arguments)
  );

  const later = await cog.run(notetaker, {
    input: 'I am planning a weekend in Porto. Any advice, given what you know about me?',
    userId: 'ana',
    threadId: 'notes-2',
  });
  console.log('\nA new conversation, the same user');
  console.log('Assistant:', later.output);

  section('2. The files as memory keeps them');

  const memory = await cog.getMemory();
  if (!memory || !isMemoryFileAdapter(memory)) {
    throw new Error('This memory adapter keeps no memory files');
  }
  const files = new MemoryFiles({ adapter: memory });
  const access = { scope: { agentId: memoryAgentId(notetaker), userId: 'ana' } };

  for (const file of await files.list(access)) {
    console.log(`${file.path} (${file.size} bytes, sha256 ${file.sha256.slice(0, 12)}...)`);
    console.log(file.content);
    const versions = await files.history(access, file.path);
    console.log(`  ${versions.length} version(s), by ${versions.map((v) => v.author).join(', ')}`);
  }
  console.log('\nWhat every run of Ana sees in its context:');
  console.log((await files.index(access)) ?? '(no files yet)');

  const other = await files.list({ scope: { agentId: memoryAgentId(notetaker), userId: 'bob' } });
  console.log(`\nFiles another user sees: ${other.length}`);

  section('3. Searching memory, with a citation lock');

  const archivistId = 'archivist';
  const threadId = 'archive-1';
  const thread = unwrap(await memory.createThread(archivistId, { userId: 'ana' }, threadId));

  const lines = [
    'My locker code at the climbing gym is 4471.',
    'Noted, 4471.',
    ...Array.from(
      { length: 40 },
      (_, i) =>
        `Note ${i}: the bakery on the corner reopened and the tram was late again in the rain.`
    ),
  ];
  for (const [index, content] of lines.entries()) {
    await memory.addEntry({
      threadId: thread.id,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
      tokenCount: countTokens(content),
    });
  }
  console.log(`Seeded ${lines.length} turns, the locker code far beyond what the history keeps`);

  const archivist = new Agent({
    name: archivistId,
    model: DEFAULT_MODEL,
    instructions:
      'Answer from memory. Use search_memory, then open_turns on the turn that answers, and cite it as [turn:<id>]. If nothing you opened answers, say that you do not remember.',
    temperature: 0,
    tools: await cog.memorySearchTools(archivistId),
  });

  const answer = await cog.run(archivist, {
    input: 'What is my locker code at the climbing gym?',
    userId: 'ana',
    threadId,
    saveHistory: false,
  });
  console.log('Tools used:', answer.toolCalls.map((call) => call.name).join(' -> '));
  console.log('Assistant:', answer.output);
  console.log(
    uncited.length === 0
      ? 'Every reference in the answer points to a turn the run opened'
      : `References taken out of the answer: ${uncited.flat().join(', ')}`
  );

  await cog.close();
  console.log('\nDone.');
}

main();
