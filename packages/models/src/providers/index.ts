import type { ModelInfo } from '../types';
import { OPENAI_MODELS } from './openai';
import { ANTHROPIC_MODELS } from './anthropic';
import { GOOGLE_MODELS } from './google';

export { OPENAI_MODELS } from './openai';
export { ANTHROPIC_MODELS } from './anthropic';
export { GOOGLE_MODELS } from './google';

export const BUILTIN_MODELS: ModelInfo[] = [
  ...OPENAI_MODELS,
  ...ANTHROPIC_MODELS,
  ...GOOGLE_MODELS,
];

export const BUILTIN_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', website: 'https://openai.com' },
  { id: 'anthropic', name: 'Anthropic', website: 'https://anthropic.com' },
  { id: 'google', name: 'Google', website: 'https://ai.google.dev' },
  { id: 'ollama', name: 'Ollama', website: 'https://ollama.com' },
  { id: 'azure', name: 'Azure OpenAI', website: 'https://azure.microsoft.com/products/ai-services/openai-service' },
  { id: 'aws', name: 'AWS Bedrock', website: 'https://aws.amazon.com/bedrock' },
  { id: 'mistral', name: 'Mistral AI', website: 'https://mistral.ai' },
  { id: 'cohere', name: 'Cohere', website: 'https://cohere.com' },
  { id: 'groq', name: 'Groq', website: 'https://groq.com' },
  { id: 'together', name: 'Together AI', website: 'https://together.ai' },
  { id: 'fireworks', name: 'Fireworks AI', website: 'https://fireworks.ai' },
  { id: 'deepinfra', name: 'DeepInfra', website: 'https://deepinfra.com' },
  { id: 'perplexity', name: 'Perplexity', website: 'https://perplexity.ai' },
  { id: 'replicate', name: 'Replicate', website: 'https://replicate.com' },
  { id: 'xai', name: 'xAI', website: 'https://x.ai' },
];
