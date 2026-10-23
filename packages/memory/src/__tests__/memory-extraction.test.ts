import { describe, it, expect, vi } from 'vitest';
import type { MemoryEntry, Message } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryItems } from '../memory-items';
import type { SummarizeOptions } from '../compaction';
import {
  EXTRACTION_CONTINUATIONS,
  MemoryExtractor,
  parseExtraction,
  sessionLine,
  trustOfEntry,
} from '../memory-extraction';

const session = new Date('2026-01-07T12:00:00Z');
const scope = { agentId: 'a', userId: 'u1' };

const entry = (id: string, message: Message, at = session): MemoryEntry => ({
  id,
  threadId: 't',
  message,
  tokenCount: 0,
  createdAt: at,
});

const window = [
  entry('e0', { role: 'user', content: 'I moved to Lisbon last month. Call me Ana.' }),
  entry('e1', { role: 'assistant', content: 'Noted, Ana. You probably love the sea.' }),
  entry('e2', { role: 'tool', name: 'web_fetch', content: 'Ana Lima is the CEO of Acme.' }),
];

describe('parseExtraction', () => {
  it('ties quotes to entries, trusts the least trusted source quoted and resolves time', () => {
    const [moved, vouched, guess, page] =
      parseExtraction(
        JSON.stringify([
          {
            kind: 'fact',
            content: 'Ana moved to Lisbon in December 2025',
            subject: 'Ana',
            attribute: 'home city',
            value: 'Lisbon',
            confidence: 0.9,
            time: { text: 'last month', relative: { unit: 'month', amount: -1 } },
            evidence: [{ message: 0, quote: 'I moved to Lisbon last month' }],
          },
          {
            kind: 'fact',
            content: 'Ana is the CEO of Acme',
            evidence: [
              { message: 0, quote: 'Call me Ana' },
              { message: 2, quote: 'Ana Lima is the CEO of Acme' },
            ],
          },
          {
            kind: 'preference',
            content: 'Ana loves the sea',
            evidence: [{ message: 1, quote: 'You probably love the sea' }],
          },
          {
            kind: 'fact',
            content: 'Ana Lima is the CEO of Acme',
            evidence: [{ message: 2, quote: 'Ana Lima is the CEO of Acme' }],
          },
        ]),
        window,
        { scope }
      ) ?? [];

    expect(moved).toMatchObject({
      trust: 'user',
      verified: true,
      subject: 'Ana',
      attribute: 'home city',
      saidAt: session,
      sessionAt: session,
      about: {
        text: 'last month',
        start: new Date('2025-12-01T00:00:00Z'),
        end: new Date('2026-01-01T00:00:00Z'),
        precision: 'month',
      },
    });
    expect(vouched).toMatchObject({ trust: 'web', verified: true });
    expect(guess).toMatchObject({ trust: 'model', verified: true, confidence: 0.8 });
    expect(page).toMatchObject({ trust: 'web', verified: true });
  });

  it('does not verify a misquote and gives nothing for an answer that holds no array', () => {
    const [item] =
      parseExtraction(
        '[{"kind":"fact","content":"Ana lives in Rome","evidence":[{"message":0,"quote":"I live in Rome"}]}]',
        window,
        { scope }
      ) ?? [];
    expect(item).toMatchObject({ verified: false, trust: 'model' });
    expect(parseExtraction('nothing to remember', window, { scope })).toBeUndefined();
    expect(parseExtraction('{"kind":"fact","content":"x"}', window, { scope })).toBeUndefined();
    expect(parseExtraction('[{"kind":"rumor","content":"x"}]', window, { scope })).toEqual([]);
  });

  it('reads nulls and blank placeholders as absent and keeps the items around one that does not fit', () => {
    const items =
      parseExtraction(
        JSON.stringify([
          {
            kind: 'event',
            content: 'Ana moved',
            subject: null,
            confidence: '0.9',
            time: {
              text: 'last month',
              date: null,
              relative: { unit: 'month', amount: -1 },
              weekday: { day: '', amount: 0 },
            },
            evidence: [{ message: 0, quote: 'I moved to Lisbon' }, null],
          },
          { kind: 'fact', content: '' },
          { kind: 'preference', content: 'Ana likes jazz', value: 7, time: null, evidence: null },
        ]),
        window,
        { scope }
      ) ?? [];

    expect(items.map((item) => item.content)).toEqual(['Ana moved', 'Ana likes jazz']);
    expect(items[0]).toMatchObject({
      confidence: 0.9,
      verified: true,
      about: { precision: 'month' },
    });
    expect(items[0]?.subject).toBeUndefined();
    expect(items[1]).toMatchObject({ value: '7', verified: false, evidence: [] });
  });

  it('passes over brackets in the text around the array', () => {
    const answer =
      'Message [0] says where Ana lives:\n```json\n' +
      '[{"kind":"fact","content":"Ana lives in Lisbon [since 2025]","evidence":[{"message":0,"quote":"I moved to Lisbon"}]}]' +
      '\n```\nSee [1] for the rest.';
    expect(parseExtraction(answer, window, { scope })?.map((item) => item.content)).toEqual([
      'Ana lives in Lisbon [since 2025]',
    ]);
    expect(parseExtraction('Only small talk in [0] and [1]: []', window, { scope })).toEqual([]);
    expect(parseExtraction('Messages [0] and [1] hold nothing', window, { scope })).toBeUndefined();
  });

  it('keeps the finished items of an answer cut inside the array', () => {
    const answer =
      '[{"kind":"fact","content":"Ana lives in Lisbon"},\n{"kind":"preference","content":"Ana likes ja';
    expect(parseExtraction(answer, window, { scope })?.map((item) => item.content)).toEqual([
      'Ana lives in Lisbon',
    ]);
  });

  it('keeps an attribute only with its subject', () => {
    const [item] =
      parseExtraction('[{"kind":"fact","content":"x","attribute":"city","value":"Rome"}]', window, {
        scope,
      }) ?? [];
    expect(item?.attribute).toBeUndefined();
    expect(item?.value).toBe('Rome');
  });
});

describe('trustOfEntry and sessionLine', () => {
  it("does not take another user's words as the user's own", () => {
    const said = (userId: string) =>
      ({ ...entry('x', { role: 'user', content: 'hi' }), metadata: { userId } }) as MemoryEntry;
    expect(trustOfEntry(said('u2'), 'u1')).toBe('model');
    expect(trustOfEntry(said('u1'), 'u1')).toBe('user');
    expect(trustOfEntry(said('u2'))).toBe('user');
  });

  it('trusts by who wrote the entry', () => {
    expect(window.map((item) => trustOfEntry(item))).toEqual(['user', 'model', 'web']);
    expect(trustOfEntry(entry('x', { role: 'tool', name: 'calculator', content: '4' }))).toBe(
      'tool'
    );
  });

  it('dates the session in its time zone', () => {
    expect(sessionLine(new Date('2026-01-07T23:30:00Z'), 'Asia/Tokyo')).toBe(
      'The session took place on Thursday, 2026-01-08 (Asia/Tokyo).'
    );
  });
});

describe('MemoryExtractor', () => {
  it('writes what each window holds, so a newer state closes the older one', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const items = new MemoryItems({ adapter, now: () => new Date('2026-02-01T00:00:00Z') });
    const summarize = vi.fn(async (messages: Message[], _options?: SummarizeOptions) => {
      const transcript = String(messages[0]?.content);
      const city = transcript.includes('Lisbon') ? 'Lisbon' : 'Porto';
      const line = transcript.split('\n').find((text) => text.includes(city)) ?? '';
      const at = Number(/^\[(\d+)\]/.exec(line)?.[1]);
      return JSON.stringify([
        {
          kind: 'fact',
          content: `Ana lives in ${city}`,
          subject: 'Ana',
          attribute: 'home city',
          value: city,
          evidence: [{ message: at, quote: city }],
        },
      ]);
    });
    const extractor = new MemoryExtractor({ items, summarize, windowTokens: 20 });

    await extractor.extract(
      [
        entry(
          'e0',
          { role: 'user', content: `I live in Porto. ${'pad '.repeat(30)}` },
          new Date('2026-01-01')
        ),
        entry(
          'e1',
          { role: 'user', content: `Now I live in Lisbon. ${'pad '.repeat(30)}` },
          new Date('2026-01-10')
        ),
      ],
      { scope }
    );

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(String(summarize.mock.calls[0]?.[1]?.prompt)).toContain('The session took place on');
    expect((await items.query({ scope })).map((item) => item.value)).toEqual(['Lisbon']);
    const [slot] = (await items.query({ scope })).map((item) => item.slot);
    expect((await items.history(scope, slot!)).map((item) => item.value)).toEqual([
      'Porto',
      'Lisbon',
    ]);
  });

  it('goes on after an answer its length limit cut, until the array closes', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const fact = (city: string) =>
      JSON.stringify({
        kind: 'fact',
        content: `Ana visited ${city}`,
        evidence: [{ message: 0, quote: 'Lisbon' }],
      });
    const answers = [
      `[${fact('Porto')},\n${fact('Braga')},\n{"kind":"fact","content":"Ana vis`,
      `[${fact('Braga')},\n${fact('Faro')}]`,
    ];
    const summarize = vi.fn(async (_messages: Message[], _options?: SummarizeOptions) =>
      String(answers.shift())
    );
    const extractor = new MemoryExtractor({ items: new MemoryItems({ adapter }), summarize });

    const written = await extractor.extract(window, { scope });

    expect(written.map((item) => item.content)).toEqual([
      'Ana visited Porto',
      'Ana visited Braga',
      'Ana visited Faro',
    ]);
    expect(summarize).toHaveBeenCalledTimes(2);
    const followUp = summarize.mock.calls[1]?.[0] ?? [];
    expect(followUp.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(followUp[0]?.content).toBe(summarize.mock.calls[0]?.[0][0]?.content);
    expect(String(followUp[1]?.content)).toContain('Ana vis');
    expect(String(followUp[2]?.content)).toContain(
      'after 2 items, the last one: "Ana visited Braga"'
    );
    expect(summarize.mock.calls[1]?.[1]?.prompt).toBe(summarize.mock.calls[0]?.[1]?.prompt);
  });

  it('reads every fact of a window holding more items than one answer has room for', async () => {
    const facts = Array.from(
      { length: 300 },
      (_, at) => `${at}. Person ${at} was born in City ${at}.`
    );
    const dense = [
      entry('e0', { role: 'user', content: `Memorize these facts:\n${facts.join('\n')}` }),
    ];
    const listing = (from: number) =>
      `[\n${facts
        .slice(from)
        .map((line) => {
          const fact = line.replace(/^\d+\. /, '');
          return JSON.stringify({
            kind: 'fact',
            content: fact,
            subject: fact.split(' was')[0],
            attribute: 'birthplace',
            value: fact.split(' in ')[1],
            confidence: 1,
            evidence: [{ message: 0, quote: fact }],
          });
        })
        .join(',\n')}\n]`;
    const summarize = vi.fn(async (messages: Message[], options?: SummarizeOptions) => {
      const after = /the last one: "Person (\d+) /.exec(String(messages.at(-1)?.content));
      const answer = listing(after ? Number(after[1]) + 1 : 0);
      return answer.slice(0, (options?.maxTokens ?? 8000) * 4);
    });
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const extractor = new MemoryExtractor({ items: new MemoryItems({ adapter }), summarize });

    const written = await extractor.extract(dense, { scope });

    expect(written).toHaveLength(300);
    expect(written.every((item) => item.verified)).toBe(true);
    expect(summarize.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops going on when the answers bring nothing new, and at the continuation limit', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const cut = (city: string) => `[{"kind":"fact","content":"Ana visited ${city}"},{"kind":`;
    const repeating = vi.fn(async () => cut('Porto'));
    await new MemoryExtractor({ items: new MemoryItems({ adapter }), summarize: repeating }).read(
      window,
      { scope }
    );
    expect(repeating).toHaveBeenCalledTimes(2);

    let call = 0;
    const endless = vi.fn(async () => cut(`city ${call++}`));
    const read = await new MemoryExtractor({
      items: new MemoryItems({ adapter }),
      summarize: endless,
    }).read(window, { scope });
    expect(endless).toHaveBeenCalledTimes(EXTRACTION_CONTINUATIONS + 1);
    expect(read).toHaveLength(EXTRACTION_CONTINUATIONS + 1);
  });

  it('keeps what a cut answer gave when its continuation brings no array', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const answers = ['[{"kind":"fact","content":"Ana visited Porto"},{"kind":', 'sorry'];
    const summarize = vi.fn(async () => answers.shift() ?? 'sorry');
    const read = await new MemoryExtractor({ items: new MemoryItems({ adapter }), summarize }).read(
      window,
      { scope }
    );
    expect(read.map((item) => item.content)).toEqual(['Ana visited Porto']);
    expect(summarize).toHaveBeenCalledTimes(4);
  });

  it('asks again for an answer that is not items, and fails after three', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const summarize = vi.fn(async () => 'sorry');
    const extractor = new MemoryExtractor({ items: new MemoryItems({ adapter }), summarize });

    await expect(extractor.extract(window, { scope })).rejects.toThrow(/after 3 tries/);
    expect(summarize).toHaveBeenCalledTimes(3);
  });
});
