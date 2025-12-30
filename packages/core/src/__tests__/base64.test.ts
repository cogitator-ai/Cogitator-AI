import { describe, it, expect } from 'vitest';
import { base64Encode, base64Decode } from '../tools/base64.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('base64Encode tool', () => {
  it('encodes string to base64', async () => {
    const result = await base64Encode.execute({ data: 'Hello, World!' }, mockContext);
    expect(result).toHaveProperty('result', 'SGVsbG8sIFdvcmxkIQ==');
    expect(result).toHaveProperty('urlSafe', false);
  });

  it('encodes empty string', async () => {
    const result = await base64Encode.execute({ data: '' }, mockContext);
    expect((result as { result: string }).result).toBe('');
  });

  it('encodes unicode characters', async () => {
    const result = await base64Encode.execute({ data: '🎉 Party!' }, mockContext);
    expect((result as { result: string }).result).toBe('8J+OiSBQYXJ0eSE=');
  });

  it('produces URL-safe encoding', async () => {
    // Data that produces + and / in standard base64
    const result = await base64Encode.execute({ data: '>>>???', urlSafe: true }, mockContext);
    const encoded = (result as { result: string }).result;
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(result).toHaveProperty('urlSafe', true);
  });

  it('has correct metadata', () => {
    expect(base64Encode.name).toBe('base64_encode');
  });
});

describe('base64Decode tool', () => {
  it('decodes base64 to string', async () => {
    const result = await base64Decode.execute({ data: 'SGVsbG8sIFdvcmxkIQ==' }, mockContext);
    expect(result).toHaveProperty('result', 'Hello, World!');
  });

  it('decodes empty string', async () => {
    const result = await base64Decode.execute({ data: '' }, mockContext);
    expect((result as { result: string }).result).toBe('');
  });

  it('decodes unicode characters', async () => {
    const result = await base64Decode.execute({ data: '8J+OiSBQYXJ0eSE=' }, mockContext);
    expect((result as { result: string }).result).toBe('🎉 Party!');
  });

  it('decodes URL-safe encoding', async () => {
    const encoded = await base64Encode.execute({ data: '>>>???', urlSafe: true }, mockContext);
    const decoded = await base64Decode.execute(
      { data: (encoded as { result: string }).result, urlSafe: true },
      mockContext
    );
    expect((decoded as { result: string }).result).toBe('>>>???');
  });

  it('round-trips correctly', async () => {
    const original = 'Test data with special chars: 日本語 🚀';
    const encoded = await base64Encode.execute({ data: original }, mockContext);
    const decoded = await base64Decode.execute(
      { data: (encoded as { result: string }).result },
      mockContext
    );
    expect((decoded as { result: string }).result).toBe(original);
  });

  it('has correct metadata', () => {
    expect(base64Decode.name).toBe('base64_decode');
  });
});
