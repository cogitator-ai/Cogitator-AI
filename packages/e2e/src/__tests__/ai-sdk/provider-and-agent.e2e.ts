import { describe, it, expect, afterAll } from 'vitest';
import { createProviderRegistry, generateText } from 'ai';
import { cogitatorModel, createCogitatorProvider } from '@cogitator-ai/ai-sdk';
import { toAISDKAgent } from '@cogitator-ai/ai-sdk/agent';
import { Agent, Cogitator } from '@cogitator-ai/core';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';

describeGoogle('AI SDK: provider registry, agents and conversations', () => {
  const cogitator = new Cogitator({
    llm: { defaultModel: MODEL, providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
    memory: { adapter: 'memory' },
  });
  const agent = new Agent({
    name: 'assistant',
    model: MODEL,
    instructions: 'Answer in one short sentence.',
    temperature: 0,
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('serves the agent through an AI SDK provider registry', async () => {
    const registry = createProviderRegistry({
      cogitator: createCogitatorProvider(cogitator, { agents: [agent] }),
    });

    const { text } = await generateText({
      model: registry.languageModel('cogitator:assistant'),
      prompt: 'What is the capital of France?',
    });

    expect(text.toLowerCase()).toContain('paris');
  });

  it('answers as an AI SDK agent', async () => {
    const result = await toAISDKAgent(cogitator, agent).generate({
      prompt: 'What is 2 + 3? Answer with the number only.',
    });

    expect(result.text).toContain('5');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('reads earlier turns of the prompt as the conversation', async () => {
    const { text } = await generateText({
      model: cogitatorModel(cogitator, agent),
      messages: [
        { role: 'user', content: 'My favourite colour is teal. Remember it.' },
        { role: 'assistant', content: 'Got it, your favourite colour is teal.' },
        { role: 'user', content: 'What is my favourite colour?' },
      ],
    });

    expect(text.toLowerCase()).toContain('teal');
  });

  it('keeps a conversation in the memory thread providerOptions names', async () => {
    const model = cogitatorModel(cogitator, agent);
    const providerOptions = { cogitator: { threadId: 'ai-sdk-e2e-thread', userId: 'ada' } };

    await generateText({
      model,
      prompt: 'My dog is called Biscuit. Remember it.',
      providerOptions,
    });
    const { text } = await generateText({
      model,
      prompt: 'What is my dog called?',
      providerOptions,
    });

    expect(text.toLowerCase()).toContain('biscuit');
  });
});
