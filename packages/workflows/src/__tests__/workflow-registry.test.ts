import { describe, it, expect } from 'vitest';
import type { Workflow } from '@cogitator-ai/types';
import { WorkflowBuilder } from '../builder';
import { WorkflowExecutor } from '../executor';
import { Cogitator } from '@cogitator-ai/core';

type ReportState = { topic: string; draft?: string };
type CountState = { count: number };

describe('workflows of different state types', () => {
  it('sit in one registry typed as plain workflows and still run', async () => {
    const report = new WorkflowBuilder<ReportState>('report')
      .initialState({ topic: 'tides' })
      .addNode('draft', async (ctx) => ({ state: { draft: `About ${ctx.state.topic}` } }), {
        config: {
          compensation: {
            compensate: async (state) => {
              expect(state.topic).toBe('tides');
            },
          },
        },
      })
      .build();
    const counter = new WorkflowBuilder<CountState>('counter')
      .initialState({ count: 0 })
      .addNode('inc', async (ctx) => ({ state: { count: ctx.state.count + 1 } }))
      .build();

    const registry: Record<string, Workflow> = { report, counter };

    const executor = new WorkflowExecutor(new Cogitator());
    const result = await executor.execute(registry.report);
    expect(result.state).toMatchObject({ topic: 'tides', draft: 'About tides' });
    expect(Object.keys(registry)).toEqual(['report', 'counter']);
  });
});
