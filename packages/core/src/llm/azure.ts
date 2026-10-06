import { AzureOpenAI } from 'openai';
import type { ChatRequest } from '@cogitator-ai/types';
import { OpenAICompatibleBackend } from './openai-compatible-base';
import { isOpenAIReasoningModel } from './openai-responses';

/** The default Azure OpenAI API version: the first that serves the GPT-5 and o-series reasoning models. */
export const DEFAULT_AZURE_API_VERSION = '2025-04-01-preview';

interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  deployment?: string;
  /**
   * The model the deployments serve, e.g. `gpt-5`, when their names do not say. Reasoning models
   * (o-series, GPT-5 and later) get no sampling parameters and `max_completion_tokens`.
   */
  model?: string;
  /** Retries the provider's SDK makes on its own; leave unset for the SDK default. The runtime passes 0 and retries itself. */
  maxRetries?: number;
}

export class AzureOpenAIBackend extends OpenAICompatibleBackend {
  readonly provider = 'azure' as const;
  protected client: AzureOpenAI;
  private defaultDeployment?: string;
  private readonly model?: string;

  constructor(config: AzureOpenAIConfig) {
    super();
    this.defaultDeployment = config.deployment;
    this.model = config.model;
    this.client = new AzureOpenAI({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      apiVersion: config.apiVersion ?? DEFAULT_AZURE_API_VERSION,
      deployment: config.deployment,
      maxRetries: config.maxRetries,
    });
  }

  protected override supportsResponseFormatWithTools(): boolean {
    return true;
  }

  protected override resolveModel(request: ChatRequest): string {
    return request.model || this.defaultDeployment || '';
  }

  /** A deployment's name is the user's choice, so the configured `model` wins over it. */
  protected override isReasoningModel(deployment: string): boolean {
    return isOpenAIReasoningModel(this.model ?? deployment);
  }
}
