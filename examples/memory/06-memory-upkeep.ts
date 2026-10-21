import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, memoryAgentId } from '@cogitator-ai/core';
import {
  isMemoryFileAdapter,
  isMemoryItemAdapter,
  MemoryFiles,
  MemoryItems,
  OBSERVATIONS_DIRECTORY,
  PLAYBOOK_PATH,
} from '@cogitator-ai/memory';
import type { Message, NewMemoryItem, RunMiddleware } from '@cogitator-ai/types';

async function main() {
  header('06 - Memory Between Runs: Brief, Observations, Consolidation');

  const turns: Message[] = [];
  const watcher: RunMiddleware = {
    name: 'example:watch-turn',
    wrapModelCall(call, next) {
      const asked = call.request.messages.findLast((message) => message.role === 'user');
      if (asked) turns.push(asked);
      return next(call);
    },
  };
  const cog = createCogitator({
    memory: {
      adapter: 'memory',
      contextBuilder: { strategy: 'recent', maxTokens: 8000, includeFacts: true },
      brief: { timeoutMs: 20_000 },
      observations: { minItems: 3 },
      consolidation: { everyRuns: 20 },
    },
    middleware: [watcher],
  });

  const concierge = new Agent({
    name: 'concierge',
    model: DEFAULT_MODEL,
    instructions: 'You help Marta plan her week. Answer in two or three sentences.',
    temperature: 0.2,
  });

  section('1. What earlier conversations established');

  const memory = await cog.getMemory();
  if (!memory || !isMemoryItemAdapter(memory) || !isMemoryFileAdapter(memory)) {
    throw new Error('This memory adapter keeps no memory items or files');
  }
  const scope = { agentId: memoryAgentId(concierge), userId: 'marta' };
  const said = (content: string, kind: NewMemoryItem['kind'] = 'fact'): NewMemoryItem => ({
    kind,
    content,
    subject: 'Marta',
    trust: 'user',
    confidence: 0.95,
    scope,
    evidence: [{ quote: content }],
    verified: true,
    status: 'active',
    saidAt: new Date('2026-10-01'),
    sessionAt: new Date('2026-10-01'),
  });
  const items = new MemoryItems({ adapter: memory });
  await items.write([
    said('Marta is vegetarian.'),
    said('Marta does not eat meat at all.'),
    said('Marta swims every Tuesday at 7am.'),
    said('Marta works as an architect in Lisbon.'),
    said(
      'Booking a table without asking about dietary needs led to a steakhouse Marta could not use, so check dietary needs before booking food.',
      'lesson'
    ),
  ]);
  console.log('Four facts and one lesson, as memory.extraction would keep them');

  section('2. A pass over memory, as a worker would run it while the agent is idle');

  const report = await cog.consolidateMemory(concierge, { userId: 'marta' });
  for (const mark of report.stale) {
    const stale = await items.get(mark.itemId);
    const kept = await items.get(mark.keptId);
    console.log(`Stale (${mark.reason}): "${stale?.content}", kept "${kept?.content}"`);
  }
  console.log(`Playbook: ${report.playbook ? `${report.playbook.edits} edit(s)` : 'unchanged'}`);
  console.log(`Observations written: ${report.observations.join(', ') || 'none'}`);

  const files = new MemoryFiles({ adapter: memory });
  for (const path of [PLAYBOOK_PATH, `${OBSERVATIONS_DIRECTORY}/marta.md`]) {
    const file = await files.read({ scope }, path);
    console.log(`\n${path}:\n${file?.content ?? '(none)'}`);
  }

  section('3. The next run: brief, observation and playbook in its turn');

  const result = await cog.run(concierge, {
    input: 'Can you book Marta a dinner table for Friday? Anything I should check first?',
    userId: 'marta',
    threadId: 'week-1',
  });
  const turn = turns.at(-1);
  console.log(
    'What the model read with the input:\n',
    typeof turn?.content === 'string' ? turn.content : JSON.stringify(turn?.content)
  );
  console.log('\nAssistant:', result.output);

  await cog.close();
  console.log('\nDone.');
}

main();
