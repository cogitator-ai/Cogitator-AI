import { describe, it, expect } from 'vitest';
import { parseModel, createLLMBackend } from '../../helpers/setup';

describe('Multi-Provider: Provider Routing', () => {
  it('parseModel extracts provider and model from string', () => {
    expect(parseModel('ollama/llama3')).toEqual({ provider: 'ollama', model: 'llama3' });
    expect(parseModel('openai/gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parseModel('anthropic/claude-3-opus')).toEqual({
      provider: 'anthropic',
      model: 'claude-3-opus',
    });
    expect(parseModel('google/gemini-flash')).toEqual({
      provider: 'google',
      model: 'gemini-flash',
    });
    expect(parseModel('just-a-model')).toEqual({ provider: null, model: 'just-a-model' });
  });

  it('createLLMBackend creates correct backend type', () => {
    const ollama = createLLMBackend('ollama', {
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    });
    expect(ollama.provider).toBe('ollama');

    const google = createLLMBackend('google', {
      providers: { google: { apiKey: 'test-key' } },
    });
    expect(google.provider).toBe('google');
  });

  it('default provider falls back to ollama when no prefix', () => {
    const { provider, model } = parseModel('llama3');
    expect(provider).toBeNull();
    expect(model).toBe('llama3');

    const backend = createLLMBackend('ollama', {
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
    });
    expect(backend.provider).toBe('ollama');
  });

  it('unknown provider throws descriptive error', () => {
    expect(() =>
      createLLMBackend('nonexistent' as any, {
        providers: {},
      })
    ).toThrow(/unknown provider/i);
  });
});
