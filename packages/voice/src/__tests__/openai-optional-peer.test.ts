import { describe, it, expect, vi } from 'vitest';

vi.mock('openai', () => {
  throw new Error("Cannot find package 'openai'");
});

import { OpenAISTT, OpenAITTS, EnergyVAD, VERSION } from '../index';

describe('openai optional peer dependency', () => {
  it('loads the package entry point without openai installed', () => {
    expect(VERSION).toEqual(expect.any(String));
    expect(new EnergyVAD().name).toBe('energy');
  });

  it('constructs OpenAI providers without loading openai', () => {
    expect(new OpenAITTS({ apiKey: 'key' }).name).toBe('openai');
    expect(new OpenAISTT({ apiKey: 'key' }).name).toBe('openai');
  });

  it('reports the missing package when an OpenAI provider is used', async () => {
    await expect(new OpenAITTS({ apiKey: 'key' }).synthesize('hello')).rejects.toThrow(
      'pnpm add openai'
    );
    await expect(new OpenAISTT({ apiKey: 'key' }).transcribe(Buffer.alloc(64))).rejects.toThrow(
      'pnpm add openai'
    );
  });

  it('reports the missing package from streaming synthesis', async () => {
    const stream = new OpenAITTS({ apiKey: 'key' }).streamSynthesize('hello');
    await expect(stream.next()).rejects.toThrow('pnpm add openai');
  });
});
