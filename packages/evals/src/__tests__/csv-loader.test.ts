import { describe, it, expect, afterEach } from 'vitest';
import { loadCsv } from '../datasets/csv-loader';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

function createTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
  return tmpDir;
}

function writeTmpFile(name: string, content: string): string {
  const filePath = path.join(createTmpDir(), name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('loadCsv', () => {
  it('loads valid CSV with input and expected columns', async () => {
    const content = [
      'input,expected',
      'What is 2+2?,4',
      'Capital of France?,Paris',
      'Hello in Spanish?,Hola',
    ].join('\n');

    const filePath = writeTmpFile('valid.csv', content);
    const cases = await loadCsv(filePath);

    expect(cases).toHaveLength(3);
    expect(cases[0]).toEqual({ input: 'What is 2+2?', expected: '4' });
    expect(cases[1]).toEqual({ input: 'Capital of France?', expected: 'Paris' });
    expect(cases[2]).toEqual({ input: 'Hello in Spanish?', expected: 'Hola' });
  });

  it('maps metadata.* columns to nested metadata object', async () => {
    const content = [
      'input,expected,metadata.difficulty,metadata.category',
      'Question 1,Answer 1,easy,math',
      'Question 2,Answer 2,hard,science',
    ].join('\n');

    const filePath = writeTmpFile('metadata.csv', content);
    const cases = await loadCsv(filePath);

    expect(cases).toHaveLength(2);
    expect(cases[0].metadata).toEqual({ difficulty: 'easy', category: 'math' });
    expect(cases[1].metadata).toEqual({ difficulty: 'hard', category: 'science' });
  });

  it('maps context.* columns to nested context object', async () => {
    const content = [
      'input,expected,context.topic,context.language',
      'Translate hello,Hola,translation,spanish',
    ].join('\n');

    const filePath = writeTmpFile('context.csv', content);
    const cases = await loadCsv(filePath);

    expect(cases).toHaveLength(1);
    expect(cases[0].context).toEqual({ topic: 'translation', language: 'spanish' });
  });

  it('throws if input column is missing', async () => {
    const content = ['expected,metadata.difficulty', 'Answer 1,easy'].join('\n');

    const filePath = writeTmpFile('no-input.csv', content);

    await expect(loadCsv(filePath)).rejects.toThrow(/input/i);
  });

  it('handles quoted fields', async () => {
    const content = [
      'input,expected',
      '"What is ""hello"" in French?",Bonjour',
      '"A, B, or C?",B',
    ].join('\n');

    const filePath = writeTmpFile('quoted.csv', content);
    const cases = await loadCsv(filePath);

    expect(cases).toHaveLength(2);
    expect(cases[0].input).toBe('What is "hello" in French?');
    expect(cases[1].input).toBe('A, B, or C?');
  });

  it('handles input-only CSV without expected column', async () => {
    const content = ['input', 'Question 1', 'Question 2'].join('\n');

    const filePath = writeTmpFile('input-only.csv', content);
    const cases = await loadCsv(filePath);

    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual({ input: 'Question 1' });
    expect(cases[1]).toEqual({ input: 'Question 2' });
  });

  it('handles metadata and context together', async () => {
    const content = [
      'input,expected,metadata.source,context.domain',
      'Test question,Test answer,manual,general',
    ].join('\n');

    const filePath = writeTmpFile('combined.csv', content);
    const cases = await loadCsv(filePath);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toEqual({
      input: 'Test question',
      expected: 'Test answer',
      metadata: { source: 'manual' },
      context: { domain: 'general' },
    });
  });
});
