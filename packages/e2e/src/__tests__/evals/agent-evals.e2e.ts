import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { RAGPipelineBuilder, MarkdownLoader, createSearchTool } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';
import type { EmbeddingService } from '@cogitator-ai/types';
import {
  EvalSuite,
  Dataset,
  contains,
  exactMatch,
  toolCalls,
  trajectory,
  passAtK,
  retrievalRecall,
  retrievalPrecision,
  retrievalMRR,
} from '@cogitator-ai/evals';
import { evalMatchers } from '@cogitator-ai/evals/matchers';

expect.extend(evalMatchers);

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const MODEL = 'google/gemini-3.5-flash-lite';
const describeIf = GOOGLE_API_KEY ? describe : describe.skip;

const VOCAB = ['refund', 'invoice', 'password', 'login', 'vacation', 'holiday'];

/** Counts vocabulary words, so retrieval is deterministic and costs no embedding calls */
function keywordEmbedding(): EmbeddingService {
  const embed = (text: string) => {
    const lower = text.toLowerCase();
    const vector = VOCAB.map((term) => lower.split(term).length - 1);
    return vector.some((v) => v > 0) ? vector : VOCAB.map(() => 0.01);
  };
  return {
    model: 'keyword-test',
    dimensions: VOCAB.length,
    embed: async (text) => embed(text),
    embedBatch: async (texts) => texts.map(embed),
  };
}

describeIf('Evals E2E: agent-native evaluation', () => {
  let cogitator: Cogitator;
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-agent-evals-'));

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { defaultModel: MODEL, providers: { google: { apiKey: GOOGLE_API_KEY! } } },
      memory: { adapter: 'memory' },
    });
  });

  afterAll(async () => {
    await cogitator.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scores tool calls and the trajectory of an agent with a tool', async () => {
    const getWeather = tool({
      name: 'get_weather',
      description: 'Current weather of a city',
      parameters: z.object({ city: z.string().describe('City name only, such as "Paris"') }),
      execute: async ({ city }) => ({ city, forecast: 'sunny', celsius: 21 }),
    });
    const agent = new Agent({
      name: 'weather-agent',
      model: MODEL,
      instructions:
        'Answer weather questions. Always call get_weather once with the bare city name, then answer in one sentence.',
      tools: [getWeather],
      temperature: 0,
    });

    const suite = new EvalSuite({
      dataset: Dataset.from([
        {
          input: 'What is the weather in Paris right now?',
          expectedToolCalls: [{ name: 'get_weather', arguments: { city: 'Paris' } }],
        },
      ]),
      target: { agent, cogitator },
      metrics: [toolCalls(), trajectory()],
      retries: 2,
      timeout: 60_000,
    });

    const result = await suite.run();
    const [caseResult] = result.results;

    expect(caseResult.error).toBeUndefined();
    expect(caseResult).toHaveCalledTool('get_weather', { city: 'Paris' });
    expect(caseResult).toFollowTrajectory(['get_weather']);
    expect(caseResult.toolResults).toEqual([
      expect.objectContaining({
        name: 'get_weather',
        result: { city: 'Paris', forecast: 'sunny', celsius: 21 },
      }),
    ]);
    expect(caseResult).toScoreAtLeast('toolCalls', 1);
    expect(result).toScoreAtLeast('trajectory', 1);
  });

  it('runs a multi-turn case on one thread so memory carries the conversation', async () => {
    const agent = new Agent({
      name: 'memory-agent',
      model: MODEL,
      instructions: 'You are a concise assistant. Remember what the user tells you.',
      temperature: 0,
    });

    const suite = new EvalSuite({
      dataset: Dataset.from([
        {
          input: 'My favorite color is teal. Reply with just OK.',
          turns: ['What is my favorite color? Answer with one word.'],
          expected: 'teal',
        },
      ]),
      target: { agent, cogitator },
      metrics: [contains()],
      retries: 2,
      timeout: 60_000,
    });

    const [caseResult] = (await suite.run()).results;

    expect(caseResult.error).toBeUndefined();
    expect(caseResult.turns).toHaveLength(2);
    expect(caseResult.turns![1].input).toBe('What is my favorite color? Answer with one word.');
    expect(caseResult.output.toLowerCase()).toContain('teal');
    expect(caseResult).toScoreAtLeast('contains', 1);
  });

  it('runs trials and scores pass@k', async () => {
    const agent = new Agent({
      name: 'math-agent',
      model: MODEL,
      instructions: 'Reply with only the number, nothing else.',
      temperature: 0,
    });

    const suite = new EvalSuite({
      dataset: Dataset.from([
        { input: 'What is 6 * 7?', expected: '42' },
        { input: 'What is 15 + 27?', expected: '42' },
      ]),
      target: { agent, cogitator },
      metrics: [exactMatch()],
      statisticalMetrics: [passAtK('exactMatch', { k: 1 }), passAtK('exactMatch', { k: 3 })],
      trials: 3,
      retries: 2,
      timeout: 60_000,
    });

    const result = await suite.run();

    expect(result.stats.total).toBe(2);
    for (const r of result.results) {
      expect(r.trials).toHaveLength(3);
      expect(r.trials!.every((t) => t.scores.some((s) => s.name === 'exactMatch'))).toBe(true);
    }
    expect(result.aggregated['passAtK(exactMatch,1)'].mean).toBeGreaterThanOrEqual(0.5);
    expect(result.aggregated['passAtK(exactMatch,3)'].mean).toBeGreaterThanOrEqual(
      result.aggregated['passAtK(exactMatch,1)'].mean
    );
    expect(result).toScoreAtLeast('exactMatch', 0.5);
  });

  it('scores retrieval through an agent with the rag_search tool', async () => {
    writeFileSync(
      join(dir, 'handbook.md'),
      '# Refunds\n\nA refund is issued within 5 days after the invoice is cancelled.\n\n# Accounts\n\nReset your password from the login page.\n\n# Time off\n\nEvery employee gets 25 vacation days and all public holiday dates off.'
    );
    const pipeline = new RAGPipelineBuilder()
      .withLoader(new MarkdownLoader())
      .withEmbeddingService(keywordEmbedding())
      .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
      .withConfig({
        chunking: { strategy: 'recursive', chunkSize: 90, chunkOverlap: 0 },
        retrieval: { strategy: 'similarity', topK: 1 },
      })
      .build();
    await pipeline.ingest(join(dir, 'handbook.md'));

    const agent = new Agent({
      name: 'handbook-agent',
      model: MODEL,
      instructions:
        'Answer questions about the company handbook. Always call rag_search once with a short query, then answer only from its results.',
      tools: [tool(createSearchTool(pipeline))],
      temperature: 0,
    });

    const suite = new EvalSuite({
      dataset: Dataset.from([
        {
          input: 'How long does a refund take after an invoice is cancelled?',
          expectedToolCalls: [{ name: 'rag_search' }],
          expectedPassages: ['A refund is issued within 5 days'],
        },
      ]),
      target: { agent, cogitator },
      metrics: [trajectory(), retrievalRecall(), retrievalPrecision(), retrievalMRR()],
      retries: 2,
      timeout: 60_000,
    });

    const [caseResult] = (await suite.run()).results;

    expect(caseResult.error).toBeUndefined();
    expect(caseResult.retrieved!.length).toBeGreaterThan(0);
    expect(caseResult).toHaveRetrieved('refund is issued within 5 days');
    expect(caseResult).toScoreAtLeast('retrievalRecall', 1);
    expect(caseResult).toScoreAtLeast('retrievalMRR', 1);
    expect(caseResult).toScoreAtLeast('trajectory', 1);
  });
});
