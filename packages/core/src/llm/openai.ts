import OpenAI from 'openai';
import { OpenAICompatibleBackend } from './openai-compatible-base';

interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
}

export class OpenAIBackend extends OpenAICompatibleBackend {
  readonly provider = 'openai' as const;
  protected client: OpenAI;

  constructor(config: OpenAIConfig) {
    super();
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }
}
