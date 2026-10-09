import type { ModelInfo } from '../types';

/** Models served only through OpenRouter, which the LiteLLM catalogue does not describe. */
export const OPENROUTER_MODELS: ModelInfo[] = [
  {
    id: 'typesafe/jev-1.13',
    provider: 'openrouter',
    displayName: 'Jev 1.13',
    pricing: { input: 0.042, output: 0 },
    contextWindow: 32_000,
    kind: 'decision',
    aliases: ['typesafe/jev-latest', '~typesafe/jev-latest'],
  },
];
