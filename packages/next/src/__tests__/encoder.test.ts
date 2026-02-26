import { describe, it, expect } from 'vitest';
import { encodeSSE, encodeDone, generateId } from '../streaming/encoder.js';

describe('encodeSSE', () => {
  const decoder = new TextDecoder();

  it('encodes data as SSE format', () => {
    const result = decoder.decode(encodeSSE({ type: 'start', messageId: 'msg_1' }));
    expect(result).toBe('data: {"type":"start","messageId":"msg_1"}\n\n');
  });

  it('encodes strings', () => {
    const result = decoder.decode(encodeSSE('hello'));
    expect(result).toBe('data: "hello"\n\n');
  });

  it('encodes null', () => {
    const result = decoder.decode(encodeSSE(null));
    expect(result).toBe('data: null\n\n');
  });
});

describe('encodeDone', () => {
  const decoder = new TextDecoder();

  it('encodes [DONE] marker', () => {
    const result = decoder.decode(encodeDone());
    expect(result).toBe('data: [DONE]\n\n');
  });
});

describe('generateId', () => {
  it('generates id with given prefix', () => {
    const id = generateId('msg');
    expect(id).toMatch(/^msg_/);
  });

  it('generates id with default prefix', () => {
    const id = generateId();
    expect(id).toMatch(/^id_/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('test')));
    expect(ids.size).toBe(100);
  });
});
