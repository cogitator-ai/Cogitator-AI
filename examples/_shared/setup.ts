import { Cogitator, type CogitatorConfig } from '@cogitator-ai/core';
import 'dotenv/config';

export const DEFAULT_MODEL = 'google/gemini-2.5-flash';

export function createCogitator(overrides: Partial<CogitatorConfig> = {}) {
  return new Cogitator({
    llm: {
      defaultProvider: 'google',
      providers: {
        google: { apiKey: process.env.GOOGLE_API_KEY },
        openai: { apiKey: process.env.OPENAI_API_KEY },
        anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
        ollama: {
          baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
        },
      },
    },
    ...overrides,
  });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`\n  Missing required env variable: ${name}`);
    console.error(`  Copy .env.example to .env and fill in the values\n`);
    process.exit(1);
  }
  return value;
}

export function header(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}\n`);
}

export function section(title: string) {
  console.log(`\n--- ${title} ---\n`);
}
