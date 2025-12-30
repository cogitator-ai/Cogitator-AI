import { describe, it, expect } from 'vitest';
import {
  countTokens,
  countMessageTokens,
  countMessagesTokens,
  truncateToTokens,
} from '../token-counter.js';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('estimates tokens based on character count', () => {
    expect(countTokens('Hello')).toBe(2);
    expect(countTokens('Hello World!')).toBe(3);
    expect(countTokens('This is a longer sentence.')).toBe(7);
  });

  it('handles unicode characters', () => {
    expect(countTokens('Привет')).toBe(2);
    expect(countTokens('🚀🌟')).toBe(1);
  });
});

describe('countMessageTokens', () => {
  it('counts tokens with message overhead', () => {
    const message = { role: 'user' as const, content: 'Hello' };
    expect(countMessageTokens(message)).toBe(6);
  });

  it('handles empty content', () => {
    const message = { role: 'system' as const, content: '' };
    expect(countMessageTokens(message)).toBe(4);
  });
});

describe('countMessagesTokens', () => {
  it('counts total tokens for multiple messages', () => {
    const messages = [
      { role: 'system' as const, content: 'You are helpful.' },
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ];
    expect(countMessagesTokens(messages)).toBe(21);
  });

  it('returns 0 for empty array', () => {
    expect(countMessagesTokens([])).toBe(0);
  });
});

describe('truncateToTokens', () => {
  it('returns text unchanged if within limit', () => {
    const text = 'Hello';
    expect(truncateToTokens(text, 10)).toBe('Hello');
  });

  it('truncates text to fit token limit', () => {
    const text = 'This is a very long sentence that needs to be truncated';
    const result = truncateToTokens(text, 5);
    expect(result).toBe('This is a very long ');
    expect(result.length).toBe(20);
  });

  it('handles edge cases', () => {
    expect(truncateToTokens('', 10)).toBe('');
    expect(truncateToTokens('Hi', 0)).toBe('');
  });
});
