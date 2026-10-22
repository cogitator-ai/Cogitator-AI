import { createProviderRegistry, generateText, streamText, type LanguageModel } from 'ai';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { Agent as AISDKAgent } from 'ai';
import { toAISDKAgent } from '../src/agent.js';
import { cogitatorModel, createCogitatorProvider } from '../src/index.js';

declare const cog: Cogitator;
declare const agent: Agent;

export async function defaultModels(): Promise<void> {
  await generateText({ model: cogitatorModel(cog, agent), prompt: 'hi' });
  await generateText({ model: cogitatorModel(cog, agent, { temperature: 0.2 }), prompt: 'hi' });
  streamText({
    model: createCogitatorProvider(cog, { agents: [agent] })('assistant'),
    prompt: 'hi',
  });
}

export const explicitV2: LanguageModel = cogitatorModel(cog, agent, { specificationVersion: 'v2' });
export const explicitV3: LanguageModel = cogitatorModel(cog, agent, { specificationVersion: 'v3' });
export const explicitV4: LanguageModel = cogitatorModel(cog, agent, { specificationVersion: 'v4' });

export const registry = createProviderRegistry({
  cogitator: createCogitatorProvider(cog, { agents: [agent] }),
});
export function registryModel(): void {
  void registry.languageModel('cogitator:assistant');
}
export const registryV3 = createProviderRegistry({
  cogitator: createCogitatorProvider(cog, { agents: [agent], specificationVersion: 'v3' }),
});

export const asAgent: AISDKAgent = toAISDKAgent(cog, agent, { temperature: 0 });
