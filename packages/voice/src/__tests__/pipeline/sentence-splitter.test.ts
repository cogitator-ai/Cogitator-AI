import { describe, it, expect } from 'vitest';
import { SentenceSplitter } from '../../pipeline/sentence-splitter';

function split(text: string, options?: { maxLength?: number }): string[] {
  const splitter = new SentenceSplitter(options);
  return [...splitter.push(text), ...splitter.flush()];
}

function splitStreamed(pieces: string[], options?: { maxLength?: number }): string[] {
  const splitter = new SentenceSplitter(options);
  return [...pieces.flatMap((piece) => splitter.push(piece)), ...splitter.flush()];
}

const trimmed = (sentences: string[]) => sentences.map((s) => s.trim());

describe('SentenceSplitter', () => {
  it('splits at sentence ends and keeps the text whole', () => {
    const text = 'Hello there. How are you? I am fine!';
    const sentences = split(text);
    expect(trimmed(sentences)).toEqual(['Hello there.', 'How are you?', 'I am fine!']);
    expect(sentences.join('')).toBe(text);
  });

  it('gives the same sentences however the text is streamed', () => {
    const text = 'Dr. Smith said 3.14 is pi. Then he left... Why?! Nobody knows.';
    const byChar = splitStreamed([...text]);
    expect(byChar).toEqual(split(text));
    expect(trimmed(byChar)).toEqual([
      'Dr. Smith said 3.14 is pi.',
      'Then he left...',
      'Why?!',
      'Nobody knows.',
    ]);
  });

  it('does not split after abbreviations, initials and dotted acronyms', () => {
    expect(
      trimmed(split('Ask Mr. Brown, e.g. by mail. J. R. R. Tolkien wrote it. The U.S. Army came.'))
    ).toEqual([
      'Ask Mr. Brown, e.g. by mail.',
      'J. R. R. Tolkien wrote it.',
      'The U.S. Army came.',
    ]);
  });

  it('does not split inside decimals or before a lowercase word', () => {
    expect(trimmed(split('It costs 3.50 dollars, approx. five euros. Next one.'))).toEqual([
      'It costs 3.50 dollars, approx. five euros.',
      'Next one.',
    ]);
  });

  it('splits an ellipsis only before a new sentence', () => {
    expect(trimmed(split('Well... maybe. Hmm... Okay.'))).toEqual([
      'Well... maybe.',
      'Hmm...',
      'Okay.',
    ]);
    expect(trimmed(split('Wait… Really?'))).toEqual(['Wait…', 'Really?']);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(trimmed(split('He said "Stop." Then (quietly.) She left.'))).toEqual([
      'He said "Stop."',
      'Then (quietly.)',
      'She left.',
    ]);
  });

  it('splits at CJK full stops without whitespace', () => {
    expect(split('你好。今天天气很好！你呢？')).toEqual(['你好。', '今天天气很好！', '你呢？']);
    expect(split('「はい。」次です。')).toEqual(['「はい。」', '次です。']);
  });

  it('splits at line breaks and keeps list numbers with their item', () => {
    const text = 'Steps:\n1. Open the app\n2. Tap start\n\n- Done';
    const sentences = split(text);
    expect(trimmed(sentences)).toEqual(['Steps:', '1. Open the app', '2. Tap start', '- Done']);
    expect(sentences.join('')).toBe(text);
  });

  it('holds a sentence end until it knows what follows', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Hello.')).toEqual([]);
    expect(splitter.push(' ')).toEqual([]);
    expect(splitter.push('World')).toEqual(['Hello. ']);
    expect(splitter.push('!')).toEqual([]);
    expect(splitter.push(' ')).toEqual(['World! ']);
  });

  it('flushes a tail without punctuation at the end', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('One. And then')).toEqual(['One. ']);
    expect(splitter.flush()).toEqual(['And then']);
    expect(splitter.flush()).toEqual([]);
  });

  it('cuts a long sentence without a break at whitespace', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const sentences = split(text, { maxLength: 20 });
    expect(sentences.join('')).toBe(text);
    for (const sentence of sentences) expect(sentence.trim().length).toBeLessThanOrEqual(20);
    expect(trimmed(sentences)).toEqual([
      'one two three four',
      'five six seven eight',
      'nine ten eleven',
      'twelve',
    ]);
  });

  it('cuts a long word at the limit without splitting a surrogate pair', () => {
    const word = 'a'.repeat(45);
    expect(split(word, { maxLength: 20 })).toEqual(['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(5)]);
    const emoji = `${'a'.repeat(19)}😀${'b'.repeat(5)}`;
    const sentences = split(emoji, { maxLength: 20 });
    expect(sentences.join('')).toBe(emoji);
    expect(sentences[0]).toBe('a'.repeat(19));
    expect(sentences[1]).toBe(`😀${'b'.repeat(5)}`);
  });

  it('cuts a sentence whose natural end is past the limit', () => {
    const text = `${'A'.repeat(300)}. Next sentence.`;
    const sentences = split(text);
    expect(sentences.join('')).toBe(text);
    for (const sentence of sentences) expect(sentence.trim().length).toBeLessThanOrEqual(250);
    expect(sentences.at(-1)!.trim()).toBe('Next sentence.');
  });

  it('splits after a number that does not open a line', () => {
    expect(trimmed(splitStreamed(['How many? ', '5. Then we go.']))).toEqual([
      'How many?',
      '5.',
      'Then we go.',
    ]);
    expect(trimmed(splitStreamed(['Steps:\n', '5. Then we go.']))).toEqual([
      'Steps:',
      '5. Then we go.',
    ]);
  });

  it('keeps a list that starts after a sentence with its items', () => {
    const text = 'Here are the steps. 1. Open it. 2. Close it.';
    const expected = ['Here are the steps.', '1. Open it.', '2. Close it.'];
    expect(trimmed(split(text))).toEqual(expected);
    expect(trimmed(splitStreamed([...text]))).toEqual(expected);
    expect(
      trimmed(splitStreamed(['Here are the steps. 1', '. Open it. 2', '. Close it.']))
    ).toEqual(expected);
  });

  it('keeps the numbers of a list in one line with their items', () => {
    expect(trimmed(split('1. Open it. 2. Close it. 3. Done.'))).toEqual([
      '1. Open it.',
      '2. Close it.',
      '3. Done.',
    ]);
    expect(trimmed(splitStreamed(['1. Open', ' it. 2', '. Close it.']))).toEqual([
      '1. Open it.',
      '2. Close it.',
    ]);
  });

  it('reads a single capital as an initial only after a capitalized word or at the start', () => {
    expect(trimmed(split('Take vitamin C. It helps. Plan B. Works too.'))).toEqual([
      'Take vitamin C.',
      'It helps.',
      'Plan B. Works too.',
    ]);
  });

  it('keeps markdown marks after a stop with their sentence', () => {
    expect(trimmed(split('**Note.** Next one. Use `x.` Then go.'))).toEqual([
      '**Note.**',
      'Next one.',
      'Use `x.`',
      'Then go.',
    ]);
  });

  it('does not return whitespace-only sentences', () => {
    expect(split('\n\nHi.\n\n')).toEqual(['\n\nHi.\n\n']);
  });

  it('rejects a maxLength that is too short or not an integer', () => {
    expect(() => new SentenceSplitter({ maxLength: 1 })).toThrow('at least 20');
    expect(() => new SentenceSplitter({ maxLength: 0 })).toThrow(RangeError);
    expect(() => new SentenceSplitter({ maxLength: 25.5 })).toThrow(RangeError);
  });
});
