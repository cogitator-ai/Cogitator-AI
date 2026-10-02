import { generateText, streamText, type LanguageModelV1 } from 'ai';
import type { Agent, Cogitator } from '@cogitator-ai/core';
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

export const explicit: LanguageModelV1 = cogitatorModel(cog, agent, { specificationVersion: 'v1' });
