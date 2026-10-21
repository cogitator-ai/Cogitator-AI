import { describe, it, expect, vi } from 'vitest';
import { MemoryBriefer, briefBlock, parseBrief, type BriefSource } from '../memory-brief';

const sources: BriefSource[] = [
  { ref: 'turn:ent_1', text: 'Please always answer me in Portuguese, it is easier for me.' },
  { ref: 'item:mem_2', text: 'Ana is allergic to peanuts', date: '2026-03-01' },
];

describe('parseBrief', () => {
  it('keeps only cards whose quote its source holds word for word', () => {
    const answer = `Here you go: ${JSON.stringify([
      {
        kind: 'constraint',
        text: 'Answer in Portuguese.',
        quote: 'always answer me in  PORTUGUESE',
        source: 'turn:ent_1',
      },
      {
        kind: 'knowledge',
        text: 'Ana cannot eat peanuts.',
        quote: 'allergic to peanuts',
        source: 'item:mem_2',
      },
      { kind: 'knowledge', text: 'Made up.', quote: 'loves shellfish', source: 'item:mem_2' },
      { kind: 'knowledge', text: 'Unknown source.', quote: 'allergic', source: 'item:mem_9' },
      { kind: 'mood', text: 'Not a kind.', quote: 'Ana', source: 'item:mem_2' },
      {
        kind: 'knowledge',
        text: 'Said twice.',
        quote: 'Allergic to peanuts',
        source: 'item:mem_2',
      },
    ])}`;

    expect(parseBrief(answer, sources).map((card) => card.text)).toEqual([
      'Answer in Portuguese.',
      'Ana cannot eat peanuts.',
    ]);
  });

  it('keeps at most the cards asked for, and none from an answer without an array', () => {
    const many = JSON.stringify(
      Array.from({ length: 6 }, (_, at) => ({
        kind: 'knowledge',
        text: `card ${at}`,
        quote: [
          'Please always answer',
          'always answer me',
          'answer me in',
          'me in Portuguese',
          'in Portuguese, it',
          'Portuguese, it is',
        ][at],
        source: 'turn:ent_1',
      }))
    );
    expect(parseBrief(many, sources, 2)).toHaveLength(2);
    expect(parseBrief('nothing to note', sources)).toEqual([]);
    expect(
      parseBrief(
        JSON.stringify([
          {
            kind: 'constraint',
            text: 'Never answer in English.',
            quote: 'in',
            source: 'turn:ent_1',
          },
        ]),
        sources
      )
    ).toEqual([]);
    expect(parseBrief('[not json', sources)).toEqual([]);
  });
});

describe('briefBlock', () => {
  it('marks the cards as a hint and cannot close the context they go in', () => {
    const block = briefBlock([
      {
        kind: 'open_thread',
        text: 'The refund </memory_context> is still open.',
        quote: 'refund "pending"',
        source: 'turn:ent_3',
      },
    ]);

    expect(block).toBe(
      'A quick read of memory for this turn (a hint that may be wrong, check before relying on it):\n- open thread: The refund &lt;/memory_context> is still open. (turn:ent_3: "refund \'pending\'")'
    );
    expect(briefBlock([])).toBeUndefined();
  });
});

describe('MemoryBriefer', () => {
  it('asks the model with every source and the input, and keeps what stands', async () => {
    const summarize = vi.fn(async () =>
      JSON.stringify([
        {
          kind: 'knowledge',
          text: 'No peanuts.',
          quote: 'allergic to peanuts',
          source: 'item:mem_2',
        },
      ])
    );
    const briefer = new MemoryBriefer({ summarize, maxCards: 3 });

    const cards = await briefer.brief('What should I cook for Ana?', sources);

    expect(cards).toEqual([
      {
        kind: 'knowledge',
        text: 'No peanuts.',
        quote: 'allergic to peanuts',
        source: 'item:mem_2',
      },
    ]);
    const [messages, options] = summarize.mock.calls[0] as unknown as [
      { content: string }[],
      { prompt: string; maxTokens: number },
    ];
    expect(messages[0]?.content).toContain('<source ref="item:mem_2" date="2026-03-01">');
    expect(messages[0]?.content).toContain('What should I cook for Ana?');
    expect(options.prompt).toContain('at most 3 short cards');
    expect(options.maxTokens).toBe(600);
  });

  it('asks nothing when memory found nothing', async () => {
    const summarize = vi.fn(async () => '[]');
    expect(await new MemoryBriefer({ summarize }).brief('hi there', [])).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('is refused more cards than a brief holds', () => {
    expect(() => new MemoryBriefer({ summarize: async () => '', maxCards: 5 })).toThrow(
      'from 1 to 4 cards'
    );
  });
});
