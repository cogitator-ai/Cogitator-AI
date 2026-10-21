import { describe, it, expect } from 'vitest';
import type {
  CompactionAtom,
  CompactionEvent,
  CompactionLevels,
  MemoryEntry,
  Message,
} from '@cogitator-ai/types';
import {
  chapterWindows,
  foldLevels,
  lostControls,
  mergeAtoms,
  parseChapter,
  renderHandoff,
  structuralAtoms,
} from '../compaction-hierarchy';
import { CompactionService, HISTORY_ENTRY_TYPES, compactedHistory } from '../compaction';
import { InMemoryAdapter } from '../adapters/memory';

const entry = (id: string, message: Message, fields: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  threadId: 't',
  message,
  tokenCount: 0,
  createdAt: new Date(0),
  ...fields,
});

const atom = (fields: Partial<CompactionAtom>): CompactionAtom => ({
  kind: 'task',
  status: 'open',
  text: 'Ship the report',
  verified: true,
  ...fields,
});

describe('parseChapter', () => {
  const window = [
    entry('e0', { role: 'user', content: 'Please ship the report by Friday.' }),
    entry('e1', { role: 'assistant', content: 'I will use the new template.' }),
  ];

  it('ties each quote to its entry and checks it', () => {
    const atoms = parseChapter(
      `Here you go: [
        {"kind": "task", "status": "open", "text": "Ship the report by Friday",
         "evidence": [{"message": 0, "quote": "ship the report by Friday"}]},
        {"kind": "decision", "text": "Use the new template",
         "evidence": [{"message": 1, "quote": "the old template"}]}
      ]`,
      window
    );

    expect(atoms).toEqual([
      {
        kind: 'task',
        status: 'open',
        text: 'Ship the report by Friday',
        evidence: [{ entryId: 'e0', quote: 'ship the report by Friday' }],
        verified: true,
      },
      {
        kind: 'decision',
        status: 'open',
        text: 'Use the new template',
        evidence: [{ entryId: 'e1', quote: 'the old template' }],
        verified: false,
      },
    ]);
  });

  it('gives nothing for an answer that holds no valid array', () => {
    expect(parseChapter('I could not do it', window)).toBeUndefined();
    expect(parseChapter('[{"kind": "mood", "text": "x"}]', window)).toBeUndefined();
  });

  it('does not verify a quote of a message the window does not have', () => {
    const [only] =
      parseChapter('[{"kind":"fact","text":"x","evidence":[{"message":9,"quote":"y"}]}]', window) ??
      [];
    expect(only?.verified).toBe(false);
  });
});

describe('structuralAtoms', () => {
  it('keeps files tools worked on, failed calls and open task lines', () => {
    const atoms = structuralAtoms([
      entry(
        'e0',
        { role: 'assistant', content: 'Plan:\n- [ ] update the changelog\n- [x] done thing' },
        { toolCalls: [{ id: 'c1', name: 'write', arguments: { path: 'src/a.ts', text: 'x' } }] }
      ),
      entry(
        'e1',
        { role: 'tool', content: 'boom', toolCallId: 'c1', name: 'write' },
        { toolResults: [{ callId: 'c1', name: 'write', result: null, error: 'disk full' }] }
      ),
    ]);

    expect(atoms.map((item) => [item.kind, item.text, item.verified])).toEqual([
      ['file', 'src/a.ts', true],
      ['task', '- [ ] update the changelog', true],
      ['error', 'write failed: disk full', true],
    ]);
  });
});

describe('mergeAtoms', () => {
  it('closes an open item only with evidence that holds', () => {
    const merged = mergeAtoms([
      { from: 'a', to: 'b', atoms: [atom({}), atom({ kind: 'error', text: 'Build fails' })] },
      {
        from: 'c',
        to: 'd',
        atoms: [
          atom({ status: 'closed', verified: false }),
          atom({ kind: 'error', text: 'build  fails', status: 'closed', verified: true }),
        ],
      },
    ]);

    expect(merged.map((item) => [item.kind, item.status])).toEqual([
      ['task', 'open'],
      ['error', 'closed'],
    ]);
  });
});

describe('foldLevels and lostControls', () => {
  const chapter = (id: string, atoms: CompactionAtom[] = []) => ({ from: id, to: id, atoms });

  it('folds old chapters into arcs and old arcs into the saga, keeping every atom', () => {
    const levels = foldLevels(
      {
        arcs: [],
        chapters: Array.from({ length: 9 }, (_, at) =>
          chapter(`c${at}`, [atom({ text: `task ${at}` })])
        ),
      },
      2,
      2
    );

    expect(levels.chapters.map((node) => node.from)).toEqual(['c8']);
    expect(levels.arcs.map((node) => [node.from, node.to])).toEqual([
      ['c4', 'c5'],
      ['c6', 'c7'],
    ]);
    expect([levels.saga?.from, levels.saga?.to]).toEqual(['c0', 'c3']);
    expect(
      lostControls({ arcs: [], chapters: [chapter('x', [atom({ text: 'task 3' })])] }, levels)
    ).toEqual([]);
  });

  it('finds an open item the new levels lost', () => {
    const before: CompactionLevels = { arcs: [], chapters: [chapter('a', [atom({})])] };
    const after: CompactionLevels = { arcs: [], chapters: [chapter('b')] };

    expect(lostControls(before, after).map((item) => item.text)).toEqual(['Ship the report']);
  });
});

describe('renderHandoff', () => {
  it('lays atoms out by what a reader goes on with, the same way every time', () => {
    const levels: CompactionLevels = {
      arcs: [],
      chapters: [
        {
          from: 'a',
          to: 'b',
          atoms: [
            atom({ kind: 'fact', text: 'User is Ana', status: 'closed' }),
            atom({}),
            atom({ kind: 'decision', text: 'Use Postgres', verified: false }),
          ],
        },
      ],
    };

    expect(renderHandoff(levels)).toBe(
      '## Open tasks\n- Ship the report\n\n## Decisions\n- Use Postgres (unverified)\n\n## Facts\n- User is Ana'
    );
    expect(renderHandoff(levels)).toBe(renderHandoff(structuredClone(levels)));
  });
});

describe('chapterWindows', () => {
  it('cuts entries into windows that open with the end of the one before', () => {
    const entries = Array.from({ length: 6 }, (_, at) =>
      entry(`e${at}`, { role: 'user', content: 'word '.repeat(40) })
    );

    const windows = chapterWindows(entries, 120);

    expect(windows.map((item) => item.own.map((own) => own.id))).toEqual([
      ['e0', 'e1'],
      ['e2', 'e3'],
      ['e4', 'e5'],
    ]);
    expect(windows.every((item) => item.window.length >= item.own.length)).toBe(true);
  });
});

describe('hierarchical compaction', () => {
  async function thread(contents: string[]) {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.createThread('agent', {}, 't');
    for (const [at, content] of contents.entries()) {
      await adapter.addEntry({
        threadId: 't',
        message: { role: at % 2 === 0 ? 'user' : 'assistant', content },
        tokenCount: 1,
      });
    }
    return adapter;
  }

  const answering = (text: (transcript: string) => string) => async (messages: Message[]) =>
    text(String(messages[0]?.content));

  it('writes chapters of grounded atoms and a handoff in place of the old conversation', async () => {
    const adapter = await thread([
      'TODO: write tests',
      'ok',
      'We picked Postgres.',
      'noted',
      'q',
      'a',
    ]);
    const service = new CompactionService({
      adapter,
      summarize: answering(
        () =>
          '[{"kind":"decision","text":"Use Postgres","evidence":[{"message":2,"quote":"picked Postgres"}]}]'
      ),
    });

    await service.compact('t', { strategy: 'hierarchical', threshold: 0, keepRecent: 2 });

    const path = await adapter.getPath({ threadId: 't', types: HISTORY_ENTRY_TYPES });
    if (!path.success) throw new Error(path.error);
    const conversation = compactedHistory(path.data);
    const summary = conversation[0]!;
    const event = summary.event as unknown as CompactionEvent;
    expect(event.levels?.chapters).toHaveLength(1);
    expect(String(summary.message.content)).toContain('## Open tasks\n- TODO: write tests');
    expect(String(summary.message.content)).toContain('## Decisions\n- Use Postgres');
    expect(conversation.slice(1).map((e) => e.message.content)).toEqual(['q', 'a']);
  });

  it('carries the levels into the next compaction and folds them', async () => {
    const adapter = await thread(['TODO: one', 'a1', 'q2', 'a2']);
    const service = new CompactionService({ adapter, summarize: answering(() => '[]') });
    const config = {
      strategy: 'hierarchical' as const,
      threshold: 0,
      keepRecent: 0,
      chaptersPerArc: 1,
    };
    await service.compact('t', config);
    for (const content of ['TODO: two', 'a3']) {
      await adapter.addEntry({ threadId: 't', message: { role: 'user', content }, tokenCount: 1 });
    }

    await service.compact('t', config);

    const path = await adapter.getPath({ threadId: 't', types: HISTORY_ENTRY_TYPES });
    if (!path.success) throw new Error(path.error);
    const [summary] = compactedHistory(path.data);
    const event = summary?.event as unknown as CompactionEvent;
    expect(event.levels?.arcs).toHaveLength(1);
    expect(event.levels?.chapters).toHaveLength(1);
    expect(String(summary?.message.content)).toContain('- TODO: one');
    expect(String(summary?.message.content)).toContain('- TODO: two');
  });

  it('asks again for an answer that is not atoms, and fails after three', async () => {
    const adapter = await thread(['q', 'a', 'q2', 'a2']);
    let asked = 0;
    const service = new CompactionService({
      adapter,
      summarize: async () => {
        asked++;
        return 'sorry';
      },
    });

    await expect(
      service.compact('t', { strategy: 'hierarchical', threshold: 0, keepRecent: 2 })
    ).rejects.toThrow(/after 3 tries/);
    expect(asked).toBe(3);
  });

  it('keeps a tail of whole turns by tokens', async () => {
    const adapter = await thread(['old question', 'old answer', 'new question', 'new answer']);
    const service = new CompactionService({ adapter, summarize: answering(() => '[]') });

    await service.compact('t', {
      strategy: 'hierarchical',
      threshold: 0,
      keepRecent: 0,
      keepRecentTokens: 15,
    });

    const path = await adapter.getPath({ threadId: 't', types: HISTORY_ENTRY_TYPES });
    if (!path.success) throw new Error(path.error);
    expect(
      compactedHistory(path.data)
        .slice(1)
        .map((e) => e.message.content)
    ).toEqual(['new question', 'new answer']);
  });
});
