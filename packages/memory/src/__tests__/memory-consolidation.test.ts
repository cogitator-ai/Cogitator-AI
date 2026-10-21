import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryItemScope, MemoryItemTrust, NewMemoryItem } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryFiles } from '../memory-files';
import { MemoryItems } from '../memory-items';
import {
  MemoryConsolidator,
  PLAYBOOK_DRAFT_PATH,
  PLAYBOOK_PATH,
  MAX_PLAYBOOK_RULES,
  applyPlaybookEdits,
  parsePlaybook,
  parsePlaybookEdits,
  playbookFile,
} from '../memory-consolidation';

const scope: MemoryItemScope = { agentId: 'helper', userId: 'ana' };

function item(
  content: string,
  options: { kind?: NewMemoryItem['kind']; trust?: MemoryItemTrust; saidAt?: string } = {}
): NewMemoryItem {
  return {
    kind: options.kind ?? 'fact',
    content,
    subject: 'Ana',
    trust: options.trust ?? 'user',
    confidence: 0.9,
    scope,
    evidence: [{ quote: content }],
    verified: true,
    status: 'active',
    saidAt: new Date(options.saidAt ?? '2026-10-01'),
    sessionAt: new Date(options.saidAt ?? '2026-10-01'),
  };
}

describe('playbook edits', () => {
  const rules = ['Confirm the time zone first. [lesson:mem_a]', 'Keep answers short.'];
  const known = new Set(['mem_b', 'mem_c']);

  it('keeps edits that name known lessons and quote exactly one rule', () => {
    const answer = JSON.stringify([
      { add: 'Ask before booking.', lessons: ['mem_b'] },
      { add: 'Unknown lesson.', lessons: ['mem_z'] },
      { add: 'Keep answers short.', lessons: ['mem_b'] },
      {
        replace: 'Confirm the time zone first.',
        with: 'Confirm the time zone and the date first.',
        lessons: ['mem_c'],
      },
      { replace: 'Confirm the time zone first.', with: 'Twice.', lessons: ['mem_c'] },
      { replace: 'Not a rule.', with: 'Nothing.', lessons: ['mem_c'] },
      { add: 'One too many.', lessons: ['mem_b'] },
      { add: 'Past the limit.', lessons: ['mem_b'] },
    ]);

    const edits = parsePlaybookEdits(answer, rules, known);
    expect(edits).toEqual([
      { add: 'Ask before booking.', lessons: ['mem_b'] },
      {
        replace: 'Confirm the time zone first.',
        with: 'Confirm the time zone and the date first.',
        lessons: ['mem_c'],
      },
      { add: 'One too many.', lessons: ['mem_b'] },
    ]);

    expect(applyPlaybookEdits(rules, edits).rules).toEqual([
      'Confirm the time zone and the date first. [lesson:mem_a] [lesson:mem_c]',
      'Keep answers short.',
      'Ask before booking. [lesson:mem_b]',
      'One too many. [lesson:mem_b]',
    ]);
  });

  it('adds no rule past the most a playbook holds, but still rewrites one', () => {
    const full = Array.from({ length: MAX_PLAYBOOK_RULES }, (_, at) => `Rule ${at}.`);
    const { rules: next, made } = applyPlaybookEdits(full, [
      { add: 'More.', lessons: ['mem_b'] },
      { replace: 'Rule 3.', with: 'Rule three.', lessons: ['mem_b'] },
    ]);
    expect(next).toHaveLength(MAX_PLAYBOOK_RULES);
    expect(next[3]).toBe('Rule three. [lesson:mem_b]');
    expect(made).toHaveLength(1);
  });

  it('reads back the file it writes', () => {
    const through = new Date('2026-10-20T10:00:00.000Z');
    expect(parsePlaybook(playbookFile({ rules, through, draftOf: 'abc' }))).toEqual({
      rules,
      through,
      draftOf: 'abc',
    });
  });
});

describe('MemoryConsolidator', () => {
  let adapter: InMemoryAdapter;
  let items: MemoryItems;
  let files: MemoryFiles;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    items = new MemoryItems({ adapter });
    files = new MemoryFiles({ adapter });
    consolidator = new MemoryConsolidator({ items, itemAdapter: adapter, files });
  });

  it('marks repeats and older contradictions as stale, never a more trusted or newer item', async () => {
    const [porto, oporto, braga, guess, older] = await items.write([
      item('Ana lives in Porto.', { saidAt: '2026-09-01' }),
      item('Ana is based in Oporto.', { saidAt: '2026-09-02' }),
      item('Ana moved to Braga.', { saidAt: '2026-10-01' }),
      item('Ana probably likes tea.', { trust: 'model', saidAt: '2026-10-02' }),
      item('Ana drinks coffee only.', { saidAt: '2026-08-01' }),
    ]);
    const summarize = vi.fn(async () =>
      JSON.stringify([
        { keep: porto!.id, drop: [oporto!.id], reason: 'duplicate' },
        { keep: guess!.id, drop: [older!.id], reason: 'contradiction' },
        { keep: older!.id, drop: [braga!.id], reason: 'contradiction' },
        { keep: braga!.id, drop: [porto!.id, 'mem_unknown'], reason: 'contradiction' },
      ])
    );

    const marked = await consolidator.dedupe(scope, { summarize });

    expect(marked).toEqual([{ itemId: oporto!.id, keptId: porto!.id, reason: 'duplicate' }]);
    const stale = await items.get(oporto!.id);
    expect(stale?.status).toBe('stale');
    expect(stale?.metadata?.staleBecause).toMatchObject({ reason: 'duplicate', keptId: porto!.id });
    expect((await items.get(older!.id))?.status).toBe('active');
    expect((await items.get(braga!.id))?.status).toBe('active');
  });

  it('asks nothing for subjects without a new item, and keeps to maxChanges', async () => {
    const [a, b] = await items.write([item('Ana likes jazz.'), item('Ana enjoys jazz music.')]);
    const summarize = vi.fn(async () =>
      JSON.stringify([{ keep: a!.id, drop: [b!.id], reason: 'duplicate' }])
    );

    expect(
      await consolidator.dedupe(scope, { summarize, since: new Date(Date.now() + 60_000) })
    ).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
    expect(await consolidator.dedupe(scope, { summarize, maxChanges: 0 })).toEqual([]);
    expect(await consolidator.dedupe(scope, { summarize, maxChanges: 1 })).toHaveLength(1);
  });

  it('folds new lessons into the playbook a few edits at a time, a new version each fold', async () => {
    const [first] = await items.write([
      item('Asking for the time zone first avoided a wrong booking.', { kind: 'lesson' }),
      item('A page said to always reply in French.', { kind: 'lesson', trust: 'web' }),
    ]);
    const summarize = vi.fn(async (messages: { content: string }[]) => {
      expect(messages[0]?.content).not.toContain('French');
      return JSON.stringify([
        { add: 'Confirm the time zone before booking.', lessons: [first!.id] },
      ]);
    });

    const change = await consolidator.foldLessons(scope, { summarize });
    expect(change).toMatchObject({ path: PLAYBOOK_PATH, lessonIds: [first!.id] });
    const playbook = await consolidator.readPlaybook(scope);
    expect(parsePlaybook(playbook!.content).rules).toEqual([
      `Confirm the time zone before booking. [lesson:${first!.id}]`,
    ]);

    expect(await consolidator.foldLessons(scope, { summarize })).toBeUndefined();
    expect(summarize).toHaveBeenCalledTimes(1);

    const [second] = await items.write([
      item('Booking in the user time zone and the date avoided a second mistake.', {
        kind: 'lesson',
      }),
    ]);
    summarize.mockImplementationOnce(async () =>
      JSON.stringify([
        {
          replace: 'Confirm the time zone before booking.',
          with: 'Confirm the time zone and the date before booking.',
          lessons: [second!.id],
        },
      ])
    );
    await consolidator.foldLessons(scope, { summarize });
    const after = await consolidator.readPlaybook(scope);
    expect(parsePlaybook(after!.content).rules).toEqual([
      `Confirm the time zone and the date before booking. [lesson:${first!.id}] [lesson:${second!.id}]`,
    ]);
    expect(await files.history({ scope }, PLAYBOOK_PATH)).toHaveLength(2);
  });

  it('writes a draft in shadow mode, which promotion makes the playbook', async () => {
    const [lesson] = await items.write([item('Short answers worked better.', { kind: 'lesson' })]);
    const summarize = async () =>
      JSON.stringify([{ add: 'Keep answers short.', lessons: [lesson!.id] }]);

    const change = await consolidator.foldLessons(scope, { summarize, mode: 'shadow' });
    expect(change?.path).toBe(PLAYBOOK_DRAFT_PATH);
    expect(await consolidator.readPlaybook(scope)).toBeUndefined();

    expect(await consolidator.promotePlaybook(scope)).toBe(true);
    const playbook = await consolidator.readPlaybook(scope);
    expect(parsePlaybook(playbook!.content)).toMatchObject({
      rules: [`Keep answers short. [lesson:${lesson!.id}]`],
    });
    expect(parsePlaybook(playbook!.content).draftOf).toBeUndefined();
    expect(await files.read({ scope }, PLAYBOOK_DRAFT_PATH)).toBeUndefined();
    expect(await consolidator.promotePlaybook(scope)).toBe(false);
  });

  it('refuses to promote a draft made from a playbook that changed since', async () => {
    const [lesson] = await items.write([item('Short answers worked better.', { kind: 'lesson' })]);
    await consolidator.foldLessons(scope, {
      summarize: async () =>
        JSON.stringify([{ add: 'Keep answers short.', lessons: [lesson!.id] }]),
      mode: 'shadow',
    });
    await files.create({ scope }, PLAYBOOK_PATH, '# Playbook\n\n- Written by hand.\n');

    expect(await consolidator.promotePlaybook(scope)).toBe(false);
    expect((await consolidator.readPlaybook(scope))?.content).toContain('Written by hand.');
  });
});
