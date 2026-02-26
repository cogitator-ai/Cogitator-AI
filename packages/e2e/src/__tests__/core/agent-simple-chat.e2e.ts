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

  it('answers factual questions with correct content', async () => {
    const agent = createTestAgent({
      instructions: 'You are a math assistant. Reply with ONLY the number, nothing else.',
    });

    const result = await cogitator.run(agent, {
      input: 'What is 2+2? Reply with ONLY the number.',
    });

    expect(result.output).toMatch(/4/);
  });

  it('follows system instructions precisely', async () => {
    const agent = createTestAgent({
      instructions:
        'You MUST start every response with the word BANANA. This is mandatory. No exceptions.',
    });

    const result = await cogitator.run(agent, {
      input: 'What is the weather like? Remember: start your response with BANANA.',
    });

    const trimmed = result.output.trim();
    expect(trimmed.toUpperCase().startsWith('BANANA')).toBe(true);
  });

  it('returns structured metadata', async () => {
    const agent = createTestAgent();

    const result = await cogitator.run(agent, {
      input: 'Say hello.',
    });

    expect(result.runId).toBeTruthy();
    expect(typeof result.runId).toBe('string');
    expect(result.agentId).toBeTruthy();
    expect(typeof result.agentId).toBe('string');
    expect(result.threadId).toBeTruthy();

    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.usage.duration).toBeGreaterThan(0);
  });

  it('respects maxTokens limit', async () => {
    const agent = createTestAgent({
      instructions: 'Write as much as possible.',
      maxTokens: 50,
    });

    const result = await cogitator.run(agent, {
      input:
        'Write a very long essay about the history of the Roman Empire. Be extremely detailed.',
    });

    expect(result.output.length).toBeLessThan(1000);

    await expectJudge(result.output, {
      question: 'Was the output short/truncated due to token limit?',
      criteria:
        'The response is relatively short, likely cut off or brief due to token constraints',
    });
  });
});
