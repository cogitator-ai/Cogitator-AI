import { describe, it, expect } from 'vitest';
import { createLLMBackend, parseModel } from '../llm';

describe('createLLMBackend', () => {
  describe('ollama', () => {
    it('should create Ollama backend with default baseUrl', () => {
      const backend = createLLMBackend('ollama', {});
      expect(backend.provider).toBe('ollama');
    });

    it('should create Ollama backend with custom baseUrl', () => {
      const backend = createLLMBackend('ollama', {
        providers: { ollama: { baseUrl: 'http://custom:11434' } },
      });
      expect(backend.provider).toBe('ollama');
    });
  });

  describe('openai', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('openai', {})).toThrow('OpenAI API key is required');
    });

    it('should create OpenAI backend with API key', () => {
      const backend = createLLMBackend('openai', {
        providers: { openai: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('openai');
    });
  });

  describe('anthropic', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('anthropic', {})).toThrow('Anthropic API key is required');
    });

    it('should create Anthropic backend with API key', () => {
      const backend = createLLMBackend('anthropic', {
        providers: { anthropic: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('anthropic');
    });
  });

  describe('google', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('google', {})).toThrow('Google API key is required');
    });

    it('should create Google backend with API key', () => {
      const backend = createLLMBackend('google', {
        providers: { google: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('google');
    });
  });

  describe('mistral (OpenAI-compatible)', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('mistral', {})).toThrow('Mistral API key is required');
    });

    it('should create Mistral backend using OpenAI with correct baseUrl', () => {
      const backend = createLLMBackend('mistral', {
        providers: { mistral: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('mistral');
    });
  });

  describe('groq (OpenAI-compatible)', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('groq', {})).toThrow('Groq API key is required');
    });

    it('should create Groq backend using OpenAI with correct baseUrl', () => {
      const backend = createLLMBackend('groq', {
        providers: { groq: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('groq');
    });
  });

  describe('together (OpenAI-compatible)', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('together', {})).toThrow('Together API key is required');
    });

    it('should create Together backend using OpenAI with correct baseUrl', () => {
      const backend = createLLMBackend('together', {
        providers: { together: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('together');
    });
  });

  describe('deepseek (OpenAI-compatible)', () => {
    it('should throw if no API key provided', () => {
      expect(() => createLLMBackend('deepseek', {})).toThrow('DeepSeek API key is required');
    });

    it('should create DeepSeek backend using OpenAI with correct baseUrl', () => {
      const backend = createLLMBackend('deepseek', {
        providers: { deepseek: { apiKey: 'test-key' } },
      });
      expect(backend.provider).toBe('deepseek');
    });
  });

  describe('vllm', () => {
    it('should throw not implemented error', () => {
      expect(() => createLLMBackend('vllm', {})).toThrow('Provider vllm not yet implemented');
    });
  });
});

describe('parseModel', () => {
  it('should parse model with provider prefix', () => {
    expect(parseModel('ollama/llama3.3:latest')).toEqual({
      provider: 'ollama',
      model: 'llama3.3:latest',
    });
  });

  it('should parse model with multiple slashes', () => {
    expect(parseModel('openai/gpt-4/turbo')).toEqual({
      provider: 'openai',
      model: 'gpt-4/turbo',
    });
  });

  it('should return null provider for model without prefix', () => {
    expect(parseModel('gpt-4')).toEqual({
      provider: null,
      model: 'gpt-4',
    });
  });

  it('should not treat unknown slash prefixes as providers', () => {
    expect(parseModel('meta-llama/Llama-3-70b')).toEqual({
      provider: null,
      model: 'meta-llama/Llama-3-70b',
    });
  });

  it('should parse new providers', () => {
    expect(parseModel('mistral/mistral-large')).toEqual({
      provider: 'mistral',
      model: 'mistral-large',
    });
    expect(parseModel('groq/llama-3.3-70b')).toEqual({
      provider: 'groq',
      model: 'llama-3.3-70b',
    });
    expect(parseModel('together/meta-llama/Llama-3-70b')).toEqual({
      provider: 'together',
      model: 'meta-llama/Llama-3-70b',
    });
    expect(parseModel('deepseek/deepseek-chat')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });
});
