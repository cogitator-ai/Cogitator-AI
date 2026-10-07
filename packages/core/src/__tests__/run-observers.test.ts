import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChatStreamChunk, LLMBackend, RunObserver, Span } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { OTLPExporter } from '../observability/opentelemetry';

function backend(reply: string): LLMBackend {
  return {
    provider: 'openai',
    chat: vi.fn(async () => ({
      id: 'r',
      content: reply,
      finishReason: 'stop' as const,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    })),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: { content: reply }, finishReason: 'stop' };
    }),
  };
}

const agent = new Agent({ name: 'watched', model: 'test/model', instructions: 'Answer.' });
const runtimes: Cogitator[] = [];

function runtime(observers: RunObserver[]): Cogitator {
  const cog = new Cogitator({ llm: { backends: { test: backend('hi') } }, observers });
  runtimes.push(cog);
  return cog;
}

afterEach(async () => {
  for (const cog of runtimes.splice(0)) await cog.close();
  vi.restoreAllMocks();
});

describe('run observers', () => {
  it('see the start, the spans and the end of every run', async () => {
    const events: string[] = [];
    const spans: Array<{ name: string; runId: string }> = [];
    const cog = runtime([
      {
        onRunStart: (event) => events.push(`start ${event.agentName} ${event.model}`),
        onSpan: (span, run) => spans.push({ name: span.name, runId: run.runId }),
        onRunComplete: (result) => events.push(`complete ${result.output}`),
      },
    ]);

    const result = await cog.run(agent, { input: 'hello' });

    expect(events).toEqual(['start watched test/model', 'complete hi']);
    expect(spans.map((s) => s.name)).toEqual(expect.arrayContaining(['llm.chat', 'agent.run']));
    expect(new Set(spans.map((s) => s.runId))).toEqual(new Set([result.runId]));
  });

  it('run after the callbacks of the run itself', async () => {
    const order: string[] = [];
    const cog = runtime([{ onRunComplete: () => order.push('observer') }]);

    await cog.run(agent, { input: 'hello', onRunComplete: () => order.push('run') });

    expect(order).toEqual(['run', 'observer']);
  });

  it('never fail a run when they throw', async () => {
    const after = vi.fn();
    const cog = runtime([
      {
        onRunStart: () => {
          throw new Error('broken observer');
        },
        onSpan: () => {
          throw new Error('broken observer');
        },
      },
      { onRunComplete: after },
    ]);

    const result = await cog.run(agent, { input: 'hello' });

    expect(result.output).toBe('hi');
    expect(after).toHaveBeenCalledOnce();
  });

  it('report a failed run', async () => {
    const failing: LLMBackend = {
      ...backend('x'),
      chat: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const errors: string[] = [];
    const cog = new Cogitator({
      llm: { backends: { test: failing }, retry: false },
      observers: [{ onRunError: (error) => errors.push(error.message) }],
    });
    runtimes.push(cog);

    await expect(cog.run(agent, { input: 'hello' })).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe('closing observers', () => {
  it('lets every observer flush on close, even when one fails', async () => {
    const closed = vi.fn();
    const cog = new Cogitator({
      llm: { backends: { test: backend('hi') } },
      observers: [
        {
          close: async () => {
            throw new Error('cannot flush');
          },
        },
        { close: closed },
      ],
    });

    await expect(cog.close()).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe('exporter observers', () => {
  it('export every span of a run with OTLP', async () => {
    const exporter = new OTLPExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      enabled: true,
    });
    const exported: Array<{ runId: string; span: Span }> = [];
    vi.spyOn(exporter, 'exportSpan').mockImplementation((runId, span) => {
      exported.push({ runId, span });
    });
    const cog = runtime([exporter.observer()]);

    const result = await cog.run(agent, { input: 'hello' });

    expect(exported.length).toBeGreaterThanOrEqual(2);
    expect(exported.every((e) => e.runId === result.runId)).toBe(true);
  });

  it('flush the OTLP exporter when the runtime closes', async () => {
    const exporter = new OTLPExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      enabled: true,
    });
    const flush = vi.spyOn(exporter, 'flush').mockResolvedValue(undefined);
    const cog = new Cogitator({
      llm: { backends: { test: backend('hi') } },
      observers: [exporter.observer()],
    });
    exporter.start();

    await cog.close();

    expect(flush).toHaveBeenCalledOnce();
  });
});
