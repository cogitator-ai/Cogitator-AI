import type { LLMProvider } from '../types.js';

export const defaultModels: Record<LLMProvider, string> = {
  ollama: 'qwen2.5:7b',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-2.0-flash',
};

export function providerEnvKey(provider: LLMProvider): string {
  const map: Record<LLMProvider, string> = {
    ollama: 'OLLAMA_BASE_URL',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  };
  return map[provider];
}

export function providerConfig(provider: LLMProvider): string {
  switch (provider) {
    case 'ollama':
      return [
        `  llm: {`,
        `    defaultProvider: 'ollama',`,
        `    providers: {`,
        `      ollama: { baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434' },`,
        `    },`,
        `  },`,
      ].join('\n');

    case 'openai':
      return [
        `  llm: {`,
        `    defaultProvider: 'openai',`,
        `    providers: {`,
        `      openai: { apiKey: process.env.OPENAI_API_KEY! },`,
        `    },`,
        `  },`,
      ].join('\n');

    case 'anthropic':
      return [
        `  llm: {`,
        `    defaultProvider: 'anthropic',`,
        `    providers: {`,
        `      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },`,
        `    },`,
        `  },`,
      ].join('\n');

    case 'google':
      return [
        `  llm: {`,
        `    defaultProvider: 'google',`,
        `    providers: {`,
        `      google: { apiKey: process.env.GOOGLE_API_KEY! },`,
        `    },`,
        `  },`,
      ].join('\n');
  }
}
