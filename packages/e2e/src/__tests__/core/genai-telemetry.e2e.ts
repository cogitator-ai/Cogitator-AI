import { describe, it, expect, afterAll } from 'vitest';
import { Agent, Cogitator, GEN_AI, agentAsTool } from '@cogitator-ai/core';
import type { Span } from '@cogitator-ai/types';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;
const MODEL = 'google/gemini-3.5-flash-lite';

describeGoogle('Core: OpenTelemetry GenAI telemetry', () => {
  const plain: Span[] = [];
  const curious: Span[] = [];
  const cog = new Cogitator({
    llm: {
      defaultModel: MODEL,
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
    },
    observers: [
      { onSpan: (span) => plain.push(span) },
      { captureContent: true, onSpan: (span) => curious.push(span) },
    ],
  });

  afterAll(async () => {
    await cog.close();
  });

  it(
    'traces an agent and the agent it calls as a tool in one trace, with content for the observer that asked',
    { timeout: 180_000 },
    async () => {
      const capitals = new Agent({
        name: 'capitals',
        model: MODEL,
        instructions: 'Answer with the capital city only, one word.',
      });
      const planner = new Agent({
        name: 'planner',
        model: MODEL,
        instructions:
          'You must call the ask_capitals tool once to find the capital, then answer with that city.',
        tools: [
          agentAsTool(cog, capitals, {
            name: 'ask_capitals',
            description: 'Asks an expert for the capital of a country',
          }),
        ],
      });

      const result = await cog.run(planner, {
        input: 'What is the capital of Japan?',
        stream: true,
        onToken: () => {},
      });

      expect(result.output.toLowerCase()).toContain('tokyo');
      const roots = plain.filter((span) => span.name === 'agent.run');
      const outer = roots.find((span) => span.attributes[GEN_AI.agentName] === 'planner');
      const inner = roots.find((span) => span.attributes[GEN_AI.agentName] === 'capitals');
      const toolSpan = plain.find((span) => span.name === 'tool.ask_capitals');
      expect(outer?.traceId).toBe(result.trace.traceId);
      expect(inner?.traceId).toBe(result.trace.traceId);
      expect(inner?.parentId).toBe(toolSpan?.id);
      expect(toolSpan?.attributes[GEN_AI.operationName]).toBe('execute_tool');

      const chats = plain.filter(
        (span) => span.name === 'llm.chat' && span.traceId === result.trace.traceId
      );
      expect(chats.length).toBeGreaterThanOrEqual(3);
      for (const chat of chats) {
        expect(chat.attributes[GEN_AI.operationName]).toBe('chat');
        expect(chat.attributes[GEN_AI.providerName]).toBe('gcp.gemini');
        expect(chat.attributes[GEN_AI.usageInputTokens]).toBeGreaterThan(0);
        expect(chat.attributes[GEN_AI.inputMessages]).toBeUndefined();
      }
      const streamed = chats.filter((span) => span.attributes[GEN_AI.requestStream] === true);
      expect(streamed.length).toBeGreaterThan(0);
      for (const span of streamed) {
        expect(span.attributes[GEN_AI.responseTimeToFirstChunk]).toBeGreaterThan(0);
      }

      const withContent = curious.filter(
        (span) => span.name === 'llm.chat' && span.traceId === result.trace.traceId
      );
      const prompts = withContent.map((span) => String(span.attributes[GEN_AI.inputMessages]));
      expect(prompts.some((prompt) => prompt.includes('capital of Japan'))).toBe(true);
      expect(
        withContent.some((span) =>
          String(span.attributes[GEN_AI.outputMessages]).toLowerCase().includes('tokyo')
        )
      ).toBe(true);
    }
  );
});
