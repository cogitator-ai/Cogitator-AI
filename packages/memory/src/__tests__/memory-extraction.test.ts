import { describe, it, expect, vi } from 'vitest';
import type { MemoryEntry, Message } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryItems } from '../memory-items';
import { MemoryExtractor, parseExtraction, sessionLine, trustOfEntry } from '../memory-extraction';

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
  it('ties quotes to entries, trusts the most trusted source and resolves time', () => {
    const [moved, guess, page] =
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
            evidence: [
              { message: 0, quote: 'I moved to Lisbon last month' },
              { message: 1, quote: 'Noted, Ana' },
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
    expect(parseExtraction('[{"kind":"rumor","content":"x"}]', window, { scope })).toBeUndefined();
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
  it('trusts by who wrote the entry', () => {
    expect(window.map(trustOfEntry)).toEqual(['user', 'model', 'web']);
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
    const summarize = vi.fn(async (messages: Message[]) => {
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

  it('asks again for an answer that is not items, and fails after three', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const summarize = vi.fn(async () => 'sorry');
    const extractor = new MemoryExtractor({ items: new MemoryItems({ adapter }), summarize });

    await expect(extractor.extract(window, { scope })).rejects.toThrow(/after 3 tries/);
    expect(summarize).toHaveBeenCalledTimes(3);
  });
});
