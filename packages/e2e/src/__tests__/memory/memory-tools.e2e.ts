import { describe, it, expect, afterAll } from 'vitest';
import { Agent, Cogitator, memoryCitations } from '@cogitator-ai/core';
import { countTokens, MemoryFiles } from '@cogitator-ai/memory';
import type { MemoryFileAdapter } from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const describeAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

const GEMINI = 'google/gemini-3.5-flash-lite';
const CLAUDE = 'anthropic/claude-haiku-5-5';

describeGoogle('Memory: search tools and memory files on Gemini', () => {
  const uncited: string[][] = [];
  const cog = new Cogitator({
    llm: {
      defaultModel: GEMINI,
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
    },
    memory: {
      adapter: 'memory',
      embedding: { provider: 'google', apiKey: process.env.GOOGLE_API_KEY! },
      contextBuilder: { strategy: 'recent', maxTokens: 600 },
      files: {},
    },
    middleware: [memoryCitations({ onUncited: (references) => uncited.push(references) })],
  });

  afterAll(async () => {
    await cog.close();
  });

  it(
    'finds an old turn with search_memory and open_turns, citing what it opened',
    { timeout: 180_000 },
    async () => {
      const tools = await cog.memorySearchTools('archivist');
      const agent = new Agent({
        name: 'archivist',
        model: GEMINI,
        instructions:
          'Answer from memory. Use search_memory, then open_turns on the turn that answers, and cite it as [turn:<id>].',
        tools,
      });
      const memory = await cog.getMemory();
      if (!memory) throw new Error('No memory');
      const threadId = 'search-tools-thread';
      await memory.createThread(agent.id, {}, threadId);
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
          threadId,
          message: { role: index % 2 === 0 ? 'user' : 'assistant', content },
          tokenCount: countTokens(content),
        });
      }
      await cog.indexMemory(threadId);

      const result = await cog.run(agent, {
        input: 'What is my locker code at the climbing gym?',
        threadId,
        saveHistory: false,
      });

      expect(result.toolCalls.map((call) => call.name)).toContain('search_memory');
      expect(result.output).toContain('4471');
      expect(uncited).toEqual([]);
    }
  );

  it(
    'keeps notes with the memory tool and sees them in a later conversation',
    { timeout: 180_000 },
    async () => {
      const agent = new Agent({
        name: 'notetaker',
        model: GEMINI,
        instructions:
          'You keep notes about the user with the memory tool. When the user tells you something to remember, create /memories/user.md with it.',
      });

      await cog.run(agent, {
        input: 'Please remember: I am allergic to peanuts.',
        userId: 'ana',
        threadId: 'notes-1',
      });

      const memory = (await cog.getMemory()) as unknown as MemoryFileAdapter;
      const files = await new MemoryFiles({ adapter: memory }).list({
        scope: { agentId: 'notetaker', userId: 'ana' },
      });
      expect(files.map((file) => file.content.toLowerCase()).join('\n')).toContain('peanut');

      const later = await cog.run(agent, {
        input: 'Which food should I avoid? Check your memory.',
        userId: 'ana',
        threadId: 'notes-2',
      });
      expect(later.output.toLowerCase()).toContain('peanut');
    }
  );
});

describeAnthropic('Memory: the native memory tool on Claude', () => {
  const cog = new Cogitator({
    llm: {
      defaultModel: CLAUDE,
      providers: {
        anthropic: {
          apiKey: process.env.ANTHROPIC_API_KEY!,
          ...(process.env.ANTHROPIC_WORKSPACE_ID && {
            headers: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID },
          }),
        },
      },
    },
    memory: { adapter: 'memory', files: {} },
  });

  afterAll(async () => {
    await cog.close();
  });

  it(
    'lets Claude write and read its memory files with its own tool',
    { timeout: 180_000 },
    async () => {
      const agent = new Agent({
        name: 'claude-notes',
        model: CLAUDE,
        instructions: 'Keep what the user asks you to remember in your memory directory.',
      });

      const first = await cog.run(agent, {
        input: 'Remember for later conversations: my favourite tea is lapsang souchong.',
        userId: 'ana',
        threadId: 'claude-1',
      });
      expect(first.toolCalls.some((call) => call.name === 'memory')).toBe(true);

      const memory = (await cog.getMemory()) as unknown as MemoryFileAdapter;
      const files = await new MemoryFiles({ adapter: memory }).list({
        scope: { agentId: 'claude-notes', userId: 'ana' },
      });
      expect(files.map((file) => file.content.toLowerCase()).join('\n')).toContain('lapsang');

      const later = await cog.run(agent, {
        input: 'What is my favourite tea?',
        userId: 'ana',
        threadId: 'claude-2',
      });
      expect(later.output.toLowerCase()).toContain('lapsang');
    }
  );
});
