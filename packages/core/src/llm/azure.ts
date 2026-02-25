import { AzureOpenAI } from 'openai';
import type { ChatRequest } from '@cogitator-ai/types';
import { OpenAICompatibleBackend } from './openai-compatible-base';

interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  deployment?: string;
}

export class AzureOpenAIBackend extends OpenAICompatibleBackend {
  readonly provider = 'azure' as const;
  protected client: AzureOpenAI;
  private defaultDeployment?: string;

  constructor(config: AzureOpenAIConfig) {
    super();
    this.defaultDeployment = config.deployment;
    this.client = new AzureOpenAI({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      apiVersion: config.apiVersion ?? '2024-08-01-preview',
      deployment: config.deployment,
    });
  }

  protected override resolveModel(request: ChatRequest): string {
    return request.model || this.defaultDeployment || '';
  }
}
