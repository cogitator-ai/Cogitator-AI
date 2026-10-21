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
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import { agentNode } from '../nodes/agent';
import { createTracer } from '../observability/tracer';

function backend(): LLMBackend {
  return {
    provider: 'openai',
    chat: vi.fn(async () => ({
      id: 'r',
      content: 'done',
      finishReason: 'stop' as const,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    })),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: 'done' }, finishReason: 'stop' };
    }),
  };
}

const runtimes: Cogitator[] = [];

function runtime(spans: Span[]): Cogitator {
  const cog = new Cogitator({
    llm: { backends: { test: backend() } },
    observers: [{ onSpan: (span) => spans.push(span) }],
  });
  runtimes.push(cog);
  return cog;
}

afterEach(async () => {
  for (const cog of runtimes.splice(0)) await cog.close();
});

const writer = new Agent({ name: 'writer', model: 'test/m', instructions: 'Write.' });
const editor = new Agent({ name: 'editor', model: 'test/m', instructions: 'Edit.' });

function twoAgentWorkflow(name = 'article') {
  return new WorkflowBuilder(name)
    .addNode('write', agentNode(writer))
    .addNode('edit', agentNode(editor), { after: ['write'] })
    .build();
}

describe('one trace for a workflow', () => {
  it('puts every agent run under a workflow span reported to the observers', async () => {
    const spans: Span[] = [];
    const cog = runtime(spans);
    const result = await new WorkflowExecutor(cog).execute(twoAgentWorkflow(), {});
    expect(result.error).toBeUndefined();

    const workflow = spans.find((span) => span.name === 'workflow.run');
    expect(workflow?.attributes).toMatchObject({
      [GEN_AI.operationName]: 'invoke_workflow',
      [GEN_AI.workflowName]: 'article',
    });
    const runs = spans.filter((span) => span.name === 'agent.run');
    expect(runs.map((span) => span.attributes[GEN_AI.agentName]).sort()).toEqual([
      'editor',
      'writer',
    ]);
    for (const run of runs) {
      expect(run.traceId).toBe(workflow?.traceId);
      expect(run.parentId).toBe(workflow?.id);
    }
  });

  it('puts each agent run under its node span when a tracer is on', async () => {
    const spans: Span[] = [];
    const cog = runtime(spans);
    const tracer = createTracer({ exporter: 'noop' });
    const startNodeSpan = vi.spyOn(tracer, 'startNodeSpan');

    await new WorkflowExecutor(cog).execute(twoAgentWorkflow(), {}, { tracer });

    const nodeSpans = startNodeSpan.mock.results.map((result) => result.value.span);
    const runs = spans.filter((span) => span.name === 'agent.run');
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const node = nodeSpans.find((span) => span.spanId === run.parentId);
      expect(node).toBeDefined();
      expect(run.traceId).toBe(node?.traceId);
    }
    expect(spans.some((span) => span.name === 'workflow.run')).toBe(false);
  });

  it('joins the trace it runs in before an incoming header the tracer kept', async () => {
    const tracer = createTracer({ exporter: 'noop' });
    tracer.setContextFromHeaders({
      traceparent: `00-${newTraceId()}-${newSpanId()}-01`,
    });
    const startWorkflowSpan = vi.spyOn(tracer, 'startWorkflowSpan');
    const traceId = newTraceId();
    const parentSpanId = newSpanId();
    await withTraceContext({ traceId, parentSpanId }, () =>
      new WorkflowExecutor({} as Cogitator).execute(
        new WorkflowBuilder('inside').addNode('a', async () => ({})).build(),
        {},
        { tracer }
      )
    );
    const span = startWorkflowSpan.mock.results[0].value.span;
    expect(span.traceId).toBe(traceId);
    expect(span.parentSpanId).toBe(parentSpanId);
  });

  it('reports its own workflow span when the tracer does not sample the workflow', async () => {
    const spans: Span[] = [];
    const cog = runtime(spans);
    const tracer = createTracer({ exporter: 'noop', sampleRate: 0 });
    await new WorkflowExecutor(cog).execute(twoAgentWorkflow(), {}, { tracer });
    const workflow = spans.find((span) => span.name === 'workflow.run');
    expect(workflow).toBeDefined();
    const runs = spans.filter((span) => span.name === 'agent.run');
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run.parentId).toBe(workflow?.id);
  });

  it('keeps workflows running at once on one tracer in traces of their own', async () => {
    const tracer = createTracer({ exporter: 'noop' });
    const startWorkflowSpan = vi.spyOn(tracer, 'startWorkflowSpan');
    const slow = (name: string) =>
      new WorkflowBuilder(name)
        .addNode('wait', async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {};
        })
        .build();
    const executor = new WorkflowExecutor({} as Cogitator);

    await Promise.all([
      executor.execute(slow('one'), {}, { tracer }),
      executor.execute(slow('two'), {}, { tracer }),
    ]);

    const [one, two] = startWorkflowSpan.mock.results.map((result) => result.value.span);
    expect(one.parentSpanId).toBeUndefined();
    expect(two.parentSpanId).toBeUndefined();
    expect(one.traceId).not.toBe(two.traceId);
    expect(tracer.getTraceContext()).toBeNull();
  });
});
