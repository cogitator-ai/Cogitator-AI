import { describe, it, expect } from 'vitest';
import { FALLBACK_MODELS } from '../utils/provider-models.js';

describe('FALLBACK_MODELS', () => {
  it('lists the current default model first for each provider', () => {
    expect(FALLBACK_MODELS.anthropic[0].value).toBe('anthropic/claude-sonnet-5-5');
    expect(FALLBACK_MODELS.openai[0].value).toBe('openai/gpt-6.1-sol');
    expect(FALLBACK_MODELS.google[0].value).toBe('google/gemini-3.8-flash');
    expect(FALLBACK_MODELS.ollama[0].value).toBe('ollama/qwen3:8b');
  });

  it('does not offer retired models', () => {
    const values = Object.values(FALLBACK_MODELS)
      .flat()
      .map((option) => option.value);

    for (const retired of [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-haiku',
      'gpt-4o',
      'o3-mini',
      'gemini-2.5',
    ]) {
      expect(values.some((value) => value.includes(retired))).toBe(false);
    }
  });
});
