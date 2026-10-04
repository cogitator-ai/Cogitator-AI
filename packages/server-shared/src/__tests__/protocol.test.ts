import { describe, it, expect } from 'vitest';
import { createFinishEvent, toRunUsage } from '../index';

describe('createFinishEvent', () => {
  const runUsage = {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    reasoningTokens: 12,
    cachedInputTokens: 8,
    cacheWriteTokens: 2,
    cost: 0.004,
    duration: 1500,
  };

  it('carries the reasoning and cache token counts of the run', () => {
    expect(createFinishEvent('msg_1', runUsage)).toEqual({
      type: 'finish',
      messageId: 'msg_1',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        reasoningTokens: 12,
        cachedInputTokens: 8,
        cacheWriteTokens: 2,
      },
    });
  });

  it('carries exactly the usage of the JSON run response', () => {
    expect(createFinishEvent('msg_1', runUsage).usage).toStrictEqual(toRunUsage(runUsage));
  });

  it('leaves out the counts the model did not report', () => {
    const event = createFinishEvent('msg_1', { inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    expect(Object.keys(event.usage ?? {})).toEqual(['inputTokens', 'outputTokens', 'totalTokens']);
  });

  it('has no usage when none is given', () => {
    expect(JSON.parse(JSON.stringify(createFinishEvent('msg_1')))).toEqual({
      type: 'finish',
      messageId: 'msg_1',
    });
  });
});
