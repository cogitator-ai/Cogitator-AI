import { describe, expect, spyOn, test } from 'bun:test';
import { createApp } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { Agent } from '@cogitator-ai/core';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig, Workflow, WorkflowState } from '@cogitator-ai/types';
import { cogitatorController } from '../index.js';
import { fakeCogitator, json, readStream, runResult } from './helpers.js';

interface CounterState extends WorkflowState {
  count: number;
  label?: string;
}

function counterWorkflow(): Workflow<WorkflowState> {
  const workflow = new WorkflowBuilder<CounterState>('counter')
    .initialState({ count: 0 })
    .addNode('increment', async (ctx) => ({ state: { count: ctx.state.count + 1 } }))
    .addNode('label', async (ctx) => ({ output: `count=${ctx.state.count}` }), {
      after: ['increment'],
    })
    .build();
  return workflow as unknown as Workflow<WorkflowState>;
}

function failingWorkflow(): Workflow<WorkflowState> {
  const workflow = new WorkflowBuilder<CounterState>('failing')
    .initialState({ count: 0 })
    .addNode('explode', async () => {
      throw new Error('node exploded');
    })
    .build();
  return workflow as unknown as Workflow<WorkflowState>;
}

function agent(name: string): Agent {
  return new Agent({ name, model: 'ollama/qwen3:0.6b', instructions: `You are ${name}.` });
}

describe('workflows', () => {
  const { cogitator } = fakeCogitator();
  const request = serve(
    createApp({
      routes: cogitatorController({
        cogitator,
        workflows: { counter: counterWorkflow(), failing: failingWorkflow() },
      }),
      reportError: () => undefined,
    })
  );

  test('lists workflows with their nodes', async () => {
    const body = (await (await request('/workflows')).json()) as {
      workflows: Array<{ name: string; entryPoint: string; nodes: string[] }>;
    };
    expect(body.workflows.map((workflow) => workflow.name)).toEqual(['counter', 'failing']);
    expect(body.workflows[0].nodes).toEqual(['increment', 'label']);
  });

  test('runs a workflow from its input state', async () => {
    const res = await request('/workflows/counter/run', json({ input: { count: 41 } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflowName: string;
      state: CounterState;
      nodeResults: Record<string, { output: unknown }>;
    };
    expect(body.workflowName).toBe('counter');
    expect(body.state.count).toBe(42);
    expect(body.nodeResults.label.output).toBe('count=42');
  });

  test('accepts an empty object as the body', async () => {
    const res = await request('/workflows/counter/run', json({}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: CounterState }).state.count).toBe(1);
  });

  test('refuses invalid options', async () => {
    const res = await request(
      '/workflows/counter/run',
      json({ options: { maxConcurrency: 0, checkpoint: 'yes' } })
    );
    expect(res.status).toBe(422);
  });

  test('answers a failed node with 500', async () => {
    const res = await request('/workflows/failing/run', json({}));
    expect(res.status).toBe(500);
  });

  test('streams node events and the completion', async () => {
    const { events, done } = await readStream(
      await request('/workflows/counter/stream', json({ input: { count: 1 } }))
    );
    expect(done).toBe(true);
    const workflowEvents = events
      .filter((event) => event.type === 'workflow')
      .map(
        (event) =>
          `${String(event.event)}:${String((event.data as { nodeName?: string }).nodeName ?? '')}`
      );
    expect(workflowEvents).toEqual([
      'node_started:increment',
      'node_completed:increment',
      'node_started:label',
      'node_completed:label',
      'workflow_completed:',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });

  test('streams a failed workflow as an error event', async () => {
    const { events, done } = await readStream(await request('/workflows/failing/stream', json({})));
    expect(done).toBe(false);
    expect(events.some((event) => event.type === 'workflow' && event.event === 'node_error')).toBe(
      true
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('swarms', () => {
  const { cogitator, run } = fakeCogitator((runAgent) =>
    Promise.resolve(runResult({ output: `${runAgent.name} says hi` }))
  );
  const team: SwarmConfig = {
    name: 'team',
    strategy: 'round-robin',
    agents: [agent('alpha'), agent('beta')],
    blackboard: { enabled: true, sections: { notes: [] }, trackHistory: false },
  };
  const quiet: SwarmConfig = {
    name: 'quiet',
    strategy: 'round-robin',
    agents: [agent('gamma')],
  };
  const request = serve(
    createApp({ routes: cogitatorController({ cogitator, swarms: { team, quiet } }) })
  );

  test('lists swarms with their agents', async () => {
    expect(await (await request('/swarms')).json()).toEqual({
      swarms: [
        { name: 'team', strategy: 'round-robin', agents: ['alpha', 'beta'] },
        { name: 'quiet', strategy: 'round-robin', agents: ['gamma'] },
      ],
    });
  });

  test('runs a swarm', async () => {
    const res = await request('/swarms/team/run', json({ input: 'hello' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      swarmName: string;
      strategy: string;
      output: unknown;
      agentResults: Record<string, { output: string }>;
    };
    expect(body.swarmName).toBe('team');
    expect(body.strategy).toBe('round-robin');
    expect(typeof body.output).toBe('string');
    expect(Object.values(body.agentResults).length).toBeGreaterThan(0);
    expect(run).toHaveBeenCalled();
  });

  test('runs every swarm agent for the authenticated user', async () => {
    const { cogitator: owned, run: ownedRun } = fakeCogitator((runAgent) =>
      Promise.resolve(runResult({ output: `${runAgent.name} says hi` }))
    );
    const authed = serve(
      createApp({
        routes: cogitatorController({
          cogitator: owned,
          swarms: { team },
          auth: () => ({ userId: 'ada' }),
        }),
      })
    );

    await authed('/swarms/team/run', json({ input: 'hello', threadId: 'plan' }));
    await readStream(
      await authed('/swarms/team/stream', json({ input: 'again', threadId: 'plan' }))
    );

    const options = ownedRun.mock.calls.map(
      (call) => call[1] as { userId?: string; threadId?: string }
    );
    expect(options.length).toBeGreaterThan(1);
    for (const option of options) {
      expect(option.userId).toBe('ada');
      expect(option.threadId?.startsWith('plan:')).toBe(true);
    }
  });

  test('streams swarm events', async () => {
    const { events, done } = await readStream(
      await request('/swarms/team/stream', json({ input: 'hello' }))
    );
    expect(done).toBe(true);
    const names = events.filter((event) => event.type === 'swarm').map((event) => event.event);
    expect(names).toContain('agent_start');
    expect(names).toContain('agent_complete');
    expect(names.at(-1)).toBe('swarm_completed');
  });

  test('reads the blackboard of a swarm that has one', async () => {
    expect(await (await request('/swarms/team/blackboard')).json()).toEqual({
      sections: { notes: [] },
    });
    const res = await request('/swarms/quiet/blackboard');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('BLACKBOARD_DISABLED');
  });

  test('closes the swarm each request builds, so a distributed one leaves no connections', async () => {
    const close = spyOn(Swarm.prototype, 'close');
    try {
      await request('/swarms/team/run', json({ input: 'hello' }));
      await (await request('/swarms/team/stream', json({ input: 'hello' }))).text();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });

  test('lists the router and the pipeline stages of a swarm', async () => {
    const { cogitator } = fakeCogitator();
    const routed = serve(
      createApp({
        routes: cogitatorController({
          cogitator,
          swarms: {
            pipeline: {
              name: 'pipeline',
              strategy: 'pipeline',
              stages: [
                { name: 'draft', agent: agent('drafter') },
                { name: 'review', agent: agent('reviewer') },
              ],
            },
            routed: {
              name: 'routed',
              strategy: 'round-robin',
              router: agent('router'),
              agents: [agent('a'), agent('b')],
            },
          },
        }),
      })
    );
    expect(await (await routed('/swarms')).json()).toEqual({
      swarms: [
        { name: 'pipeline', strategy: 'pipeline', agents: ['drafter', 'reviewer'] },
        { name: 'routed', strategy: 'round-robin', agents: ['a', 'b', 'router'] },
      ],
    });
  });

  test('answers 404 for an unknown swarm', async () => {
    const res = await request('/swarms/ghost/run', json({ input: 'hello' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('SWARM_NOT_FOUND');
  });
});
