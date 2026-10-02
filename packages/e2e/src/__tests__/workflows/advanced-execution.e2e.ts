import { describe, it, expect, beforeAll } from 'vitest';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  NodeTimeoutError,
  agentNode,
  subworkflowNode,
  subworkflowWorkflowNode,
  createTracer,
  createMetricsCollector,
} from '@cogitator-ai/workflows';
import type { Cogitator } from '@cogitator-ai/core';
import { createTestAgent, createTestCogitator, isOllamaRunning } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

type JoinState = { a?: string; b?: string; b2?: string; merged?: string };
type ChildState = { question: string; answer?: string };
type ParentState = { question: string; answer?: string };

describeE2E('Workflows: advanced execution with real agents', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  it('joins unequal agent branches exactly once', { timeout: 180_000 }, async () => {
    const replier = (name: string) =>
      createTestAgent({ name, instructions: 'Reply with one short sentence.', maxTokens: 40 });
    let mergeRuns = 0;

    const workflow = new WorkflowBuilder<JoinState>('join-agents')
      .initialState({})
      .addParallel('fan', ['a', 'b'])
      .addNode(
        'a',
        agentNode<JoinState>(replier('agent-a'), {
          inputMapper: () => 'Say hello',
          stateMapper: (r) => ({ a: r.output }),
        })
      )
      .addNode(
        'b',
        agentNode<JoinState>(replier('agent-b'), {
          inputMapper: () => 'Say goodbye',
          stateMapper: (r) => ({ b: r.output }),
        })
      )
      .addNode(
        'b2',
        agentNode<JoinState>(replier('agent-b2'), {
          inputMapper: (state) => `Rephrase: ${state.b ?? ''}`,
          stateMapper: (r) => ({ b2: r.output }),
        }),
        { after: ['b'] }
      )
      .addNode(
        'merge',
        async (ctx) => {
          mergeRuns++;
          return { state: { merged: `${ctx.state.a ?? ''} | ${ctx.state.b2 ?? ''}` } };
        },
        { after: ['a', 'b2'] }
      )
      .build();

    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeUndefined();
    expect(mergeRuns).toBe(1);
    expect(result.state.b2?.length ?? 0).toBeGreaterThan(0);
    expect(result.state.merged).toContain(result.state.b2!);
  });

  it('times out a slow agent node with NodeTimeoutError', { timeout: 120_000 }, async () => {
    const writer = createTestAgent({
      name: 'essayist',
      instructions: 'Write an extremely long essay of at least 3000 words.',
    });

    const workflow = new WorkflowBuilder('timeout-agent')
      .addNode('essay', agentNode(writer, { inputMapper: () => 'History of mathematics' }), {
        config: { timeout: 200 },
      })
      .build();

    const started = Date.now();
    const result = await new WorkflowExecutor(cogitator).execute(workflow);

    expect(result.error).toBeInstanceOf(NodeTimeoutError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it(
    'runs an agent child workflow as a subworkflow node with tracing',
    { timeout: 180_000 },
    async () => {
      const answerer = createTestAgent({
        name: 'answerer',
        instructions: 'Answer in one short sentence.',
        maxTokens: 60,
      });
      const child = new WorkflowBuilder<ChildState>('answer-child')
        .initialState({ question: '' })
        .addNode(
          'answer',
          agentNode<ChildState>(answerer, {
            inputMapper: (state) => state.question,
            stateMapper: (r) => ({ answer: r.output }),
          })
        )
        .build();

      const parent = new WorkflowBuilder<ParentState>('answer-parent')
        .initialState({ question: '' })
        .addNode(
          'delegate',
          subworkflowWorkflowNode(
            subworkflowNode<ParentState, ChildState>('delegate', {
              workflow: child,
              inputMapper: (state) => ({ question: state.question }),
              outputMapper: (r, state) => ({ ...state, answer: r.state.answer }),
            })
          )
        )
        .build();

      const tracer = createTracer({ enabled: true, exporter: 'console' });
      const metricsCollector = createMetricsCollector();

      const result = await new WorkflowExecutor(cogitator).execute(
        parent,
        { question: 'What color is the sky on a clear day?' },
        { tracer, metricsCollector }
      );

      expect(result.error).toBeUndefined();
      expect(result.state.answer?.length ?? 0).toBeGreaterThan(0);
      expect(metricsCollector.getWorkflowMetrics('answer-parent')?.successCount).toBe(1);
    }
  );

  it('cancels an in-flight agent node when the run is aborted', { timeout: 120_000 }, async () => {
    const writer = createTestAgent({
      name: 'long-writer',
      instructions: 'Write an extremely long story of at least 3000 words.',
    });
    const workflow = new WorkflowBuilder('abortable')
      .addNode('story', agentNode(writer, { inputMapper: () => 'A dragon' }))
      .build();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const started = Date.now();
    const result = await new WorkflowExecutor(cogitator).execute(
      workflow,
      {},
      {
        signal: controller.signal,
      }
    );

    expect(result.error).toBeDefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
