import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Agent Simple Chat', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('answers factual questions correctly', async () => {
    const agent = createTestAgent();
    const result = await cogitator.run(agent, {
      input: 'What is the capital of Japan? Reply in one word.',
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'What is the capital of Japan?',
      criteria: 'Answer correctly names Tokyo',
    });
  });

  it('follows system instructions', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a geography expert. When asked about colors, always explain the science behind it.',
    });
    const result = await cogitator.run(agent, {
      input: 'What color is the sky?',
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'What color is the sky?',
      criteria: 'Response mentions the sky being blue or references light/atmosphere/science',
    });
  });

  it('handles minimal input gracefully', async () => {
    const agent = createTestAgent();
    const result = await cogitator.run(agent, {
      input: 'Hi',
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
