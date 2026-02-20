import { describe, it, expect, afterEach } from 'vitest';
import { loadJsonl } from '../datasets/jsonl-loader';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

function createTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
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

describe('loadJsonl', () => {
  it('loads valid JSONL file', async () => {
    const content = [
      JSON.stringify({ input: 'What is 2+2?', expected: '4' }),
      JSON.stringify({ input: 'Capital of France?', expected: 'Paris' }),
      JSON.stringify({ input: 'Hello in Spanish?', expected: 'Hola' }),
    ].join('\n');

    const filePath = writeTmpFile('valid.jsonl', content);
    const cases = await loadJsonl(filePath);

    expect(cases).toHaveLength(3);
    expect(cases[0]).toEqual({ input: 'What is 2+2?', expected: '4' });
    expect(cases[1]).toEqual({ input: 'Capital of France?', expected: 'Paris' });
    expect(cases[2]).toEqual({ input: 'Hello in Spanish?', expected: 'Hola' });
  });

  it('skips empty lines', async () => {
    const content = [
      JSON.stringify({ input: 'first' }),
      '',
      '   ',
      JSON.stringify({ input: 'second' }),
      '',
    ].join('\n');

    const filePath = writeTmpFile('empty-lines.jsonl', content);
    const cases = await loadJsonl(filePath);

    expect(cases).toHaveLength(2);
    expect(cases[0].input).toBe('first');
    expect(cases[1].input).toBe('second');
  });

  it('throws on invalid JSON with line number', async () => {
    const content = [
      JSON.stringify({ input: 'valid' }),
      '{ broken json',
      JSON.stringify({ input: 'also valid' }),
    ].join('\n');

    const filePath = writeTmpFile('invalid.jsonl', content);

    await expect(loadJsonl(filePath)).rejects.toThrow(/line 2/i);
  });

  it('validates each case against EvalCaseSchema', async () => {
    const content = [
      JSON.stringify({ input: 'valid case' }),
      JSON.stringify({ notInput: 'missing input field' }),
    ].join('\n');

    const filePath = writeTmpFile('invalid-schema.jsonl', content);

    await expect(loadJsonl(filePath)).rejects.toThrow();
  });

  it('handles file with single case', async () => {
    const content = JSON.stringify({ input: 'only one', expected: 'answer' });
    const filePath = writeTmpFile('single.jsonl', content);
    const cases = await loadJsonl(filePath);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toEqual({ input: 'only one', expected: 'answer' });
  });

  it('preserves metadata and context fields', async () => {
    const content = JSON.stringify({
      input: 'test',
      expected: 'result',
      metadata: { difficulty: 'hard', source: 'manual' },
      context: { topic: 'math' },
    });

    const filePath = writeTmpFile('full-fields.jsonl', content);
    const cases = await loadJsonl(filePath);

    expect(cases).toHaveLength(1);
    expect(cases[0].metadata).toEqual({ difficulty: 'hard', source: 'manual' });
    expect(cases[0].context).toEqual({ topic: 'math' });
  });

  it('throws on non-existent file', async () => {
    await expect(loadJsonl('/tmp/does-not-exist-abc123.jsonl')).rejects.toThrow();
  });
});
