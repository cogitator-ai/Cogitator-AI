import type { LLMProvider } from '@cogitator-ai/types';

const KNOWN_PROVIDERS: readonly LLMProvider[] = [
  'ollama',
  'openai',
  'anthropic',
  'google',
  'azure',
  'bedrock',
  'vllm',
  'mistral',
  'groq',
  'together',
  'deepseek',
];

/** Whether `provider` names a backend built into Cogitator. */
export function isLLMProvider(provider: string): provider is LLMProvider {
  return KNOWN_PROVIDERS.includes(provider as LLMProvider);
}
