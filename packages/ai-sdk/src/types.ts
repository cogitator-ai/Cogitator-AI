import type { Tool } from '@cogitator-ai/types';
import type { LanguageModelV1 } from '@ai-sdk/provider';
import type { Agent } from '@cogitator-ai/core';

export interface CogitatorProviderOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface CogitatorProviderConfig {
  agents: Agent[] | Map<string, Agent> | Record<string, Agent>;
}

export interface CogitatorProvider {
  (agentName: string, options?: CogitatorProviderOptions): LanguageModelV1;
  languageModel(agentName: string, options?: CogitatorProviderOptions): LanguageModelV1;
}

export interface AISDKModelWrapperOptions {
  defaultModel?: string;
}

export type CogitatorTool<TParams = unknown, TResult = unknown> = Tool<TParams, TResult>;
