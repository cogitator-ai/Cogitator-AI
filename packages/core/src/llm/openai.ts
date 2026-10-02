import OpenAI from 'openai';
import type { LLMProvider } from '@cogitator-ai/types';
import { OpenAICompatibleBackend } from './openai-compatible-base';

interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  provider?: LLMProvider;
}

export class OpenAIBackend extends OpenAICompatibleBackend {
  readonly provider: LLMProvider;
  protected client: OpenAI;
  protected override readonly maxTokensField: 'max_tokens' | 'max_completion_tokens';

  constructor(config: OpenAIConfig) {
    super();
    this.provider = config.provider ?? 'openai';
    this.maxTokensField =
      this.provider === 'openai' && !config.baseUrl ? 'max_completion_tokens' : 'max_tokens';
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }
}
