import { describe, it, expect } from 'vitest';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { toAISDKAgent } from '../agent';
import { createAgent, createFakeCogitator } from './helpers';

const search = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ q: z.string() }),
  execute: async ({ q }) => ({ hits: [q] }),
});

describe('toAISDKAgent', () => {
  it('is an agent-v1 named after the Cogitator agent, with no AI SDK tools of its own', () => {
    const { cogitator } = createFakeCogitator();
    const agent = toAISDKAgent(cogitator, createAgent('support'));

    expect(agent.version).toBe('agent-v1');
    expect(agent.id).toBe('support');
    expect(agent.tools).toEqual({});
    expect(toAISDKAgent(cogitator, createAgent('support'), { id: 'helpdesk' }).id).toBe('helpdesk');
  });

  it('generates with the Cogitator agent, one step with its tool calls run inside it', async () => {
    const { cogitator, run } = createFakeCogitator({
      toolSteps: [{ call: { id: 'call_1', name: 'search', arguments: { q: 'order 42' } } }],
      output: 'Order 42 ships tomorrow.',
    });
    const agent = toAISDKAgent(cogitator, createAgent('support', [search]));

    const result = await agent.generate({ prompt: 'Where is order 42?' });

    expect(result.text).toBe('Order 42 ships tomorrow.');
    expect(result.steps).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1].input).toBe('Where is order 42?');
    expect(result.usage.inputTokens).toBe(10);
  });

  it('streams the text of the Cogitator agent', async () => {
    const { cogitator } = createFakeCogitator({ tokens: ['Ships', ' tomorrow.'] });
    const agent = toAISDKAgent(cogitator, createAgent('support'));

    const result = await agent.stream({ prompt: 'Where is order 42?' });
    let text = '';
    for await (const delta of result.textStream) text += delta;

    expect(text).toBe('Ships tomorrow.');
  });

  it('passes the settings it takes on to every call', async () => {
    const { cogitator, run } = createFakeCogitator();
    const agent = toAISDKAgent(cogitator, createAgent('support'), { temperature: 0.1 });

    await agent.generate({ prompt: 'Hi' });

    expect(run.mock.calls[0]?.[0].config.temperature).toBe(0.1);
  });
});
