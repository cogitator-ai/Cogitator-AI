import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';

describeGoogle('Core: a turn cut at the token limit', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: MODEL,
        providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
      },
    });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  for (const stream of [false, true]) {
    it(`never runs a tool call it cut off (stream: ${stream})`, { timeout: 120_000 }, async () => {
      const saved: string[] = [];
      const saveReport = tool({
        name: 'save_report',
        description: 'Save a long written report',
        parameters: z.object({
          report: z.string().describe('The full report, at least 300 words'),
        }),
        execute: async ({ report }) => {
          saved.push(report);
          return 'saved';
        },
      });
      const agent = new Agent({
        name: 'reporter',
        model: MODEL,
        instructions:
          'Always call save_report with a detailed report of at least 300 words. Never answer in text.',
        tools: [saveReport],
        maxTokens: 24,
      });

      const result = await cogitator.run(agent, {
        input: 'Write and save a report on the history of the printing press.',
        ...(stream && { stream: true, onToken: () => undefined }),
      });

      expect(result.truncated).toBe(true);
      expect(saved).toEqual([]);
      expect(result.toolCalls).toEqual([]);
    });
  }
});
