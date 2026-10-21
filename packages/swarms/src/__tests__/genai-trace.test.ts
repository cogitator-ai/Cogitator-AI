import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Agent,
  Cogitator,
  GEN_AI,
  newSpanId,
  newTraceId,
  withTraceContext,
} from '@cogitator-ai/core';
import type { ChatStreamChunk, LLMBackend, Span } from '@cogitator-ai/types';
import { Swarm } from '../swarm';

function backend(): LLMBackend {
  return {
    provider: 'openai',
    chat: vi.fn(async () => ({
      id: 'r',
      content: 'step done',
      finishReason: 'stop' as const,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    })),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: 'step done' }, finishReason: 'stop' };
    }),
  };
}

const runtimes: Cogitator[] = [];

afterEach(async () => {
  for (const cog of runtimes.splice(0)) await cog.close();
});

function pipelineSwarm(spans: Span[]) {
  const cog = new Cogitator({
    llm: { backends: { test: backend() } },
    observers: [{ onSpan: (span) => spans.push(span) }],
  });
  runtimes.push(cog);
  const stage = (name: string) =>
    new Agent({ name, model: 'test/m', instructions: `Do the ${name} step.` });
  return new Swarm(cog, {
    name: 'editorial',
    strategy: 'pipeline',
    pipeline: {
      stages: [
        { name: 'draft', agent: stage('drafter') },
        { name: 'review', agent: stage('reviewer') },
      ],
    },
  });
}

describe('one trace for a swarm run', () => {
  it('reports an invoke_workflow span with every agent run under it', async () => {
    const spans: Span[] = [];
    await pipelineSwarm(spans).run({ input: 'Write about tracing' });

    const root = spans.find((span) => span.name === 'swarm.run');
    expect(root?.attributes).toMatchObject({
      [GEN_AI.operationName]: 'invoke_workflow',
      [GEN_AI.workflowName]: 'editorial',
      'swarm.strategy': 'pipeline',
    });
    expect(root?.status).toBe('ok');
    const runs = spans.filter((span) => span.name === 'agent.run');
    expect(runs.map((span) => span.attributes[GEN_AI.agentName]).sort()).toEqual([
      'drafter',
      'reviewer',
    ]);
    for (const run of runs) {
      expect(run.traceId).toBe(root?.traceId);
      expect(run.parentId).toBe(root?.id);
    }
  });

  it('joins the trace it is started in', async () => {
    const spans: Span[] = [];
    const traceId = newTraceId();
    const parentSpanId = newSpanId();
    await withTraceContext({ traceId, parentSpanId }, () =>
      pipelineSwarm(spans).run({ input: 'Write about tracing' })
    );
    const root = spans.find((span) => span.name === 'swarm.run');
    expect(root?.traceId).toBe(traceId);
    expect(root?.parentId).toBe(parentSpanId);
  });
});
