import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DelegatedRunStart, RunDataPart } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { agentAsTool } from '../agent-tool';
import { answer, callTools, scriptedBackend } from './helpers/scripted-backend';

describe('tool data parts and run state', () => {
  it('reports the data parts a tool sends, updated in place by id', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'forecast', arguments: { city: 'Oslo' } }]),
      answer('Cold'),
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: scripted.backend } } });
    const forecast = tool({
      name: 'forecast',
      description: 'Forecast',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }, context) => {
        const id = context.data?.({ name: 'weather', data: { city, loading: true } });
        context.data?.({ id, name: 'weather', data: { city, temp: -3 } });
        context.data?.({ name: 'status', data: 'done', transient: true });
        return { temp: -3 };
      },
    });
    const parts: RunDataPart[] = [];

    const result = await cog.run(
      new Agent({ name: 'w', model: 'mock/m', instructions: 'Help.', tools: [forecast] }),
      { input: 'Weather?', onData: (part) => parts.push(part) }
    );

    expect(result.output).toBe('Cold');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      name: 'weather',
      data: { city: 'Oslo', loading: true },
      toolCallId: 'c1',
      toolName: 'forecast',
    });
    expect(parts[0]?.id).toMatch(/^data_/);
    expect(parts[1]).toMatchObject({ id: parts[0]?.id, data: { city: 'Oslo', temp: -3 } });
    expect(parts[2]).toMatchObject({ name: 'status', transient: true });
    expect(parts[2]?.id).not.toBe(parts[0]?.id);
    expect(JSON.stringify(result.messages)).not.toContain('loading');
  });

  it('gives tools the run state and reports each change', async () => {
    const scripted = scriptedBackend([
      callTools([
        { id: 'c1', name: 'add_item', arguments: { item: 'milk' } },
        { id: 'c2', name: 'add_item', arguments: { item: 'eggs' } },
      ]),
      answer('Added'),
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: scripted.backend } } });
    const addItem = tool({
      name: 'add_item',
      description: 'Adds to the list',
      parameters: z.object({ item: z.string() }),
      execute: async ({ item }, context) => {
        const current = context.state?.get();
        const items =
          typeof current === 'object' && current !== null && 'items' in current
            ? (current.items as string[])
            : [];
        context.state?.set({ items: [...items, item] });
        return 'ok';
      },
    });
    const states: unknown[] = [];

    await cog.run(
      new Agent({ name: 'w', model: 'mock/m', instructions: 'Help.', tools: [addItem] }),
      { input: 'Shop', state: { items: ['bread'] }, onState: (state) => states.push(state) }
    );

    expect(states).toEqual([{ items: ['bread', 'milk'] }, { items: ['bread', 'milk', 'eggs'] }]);
  });

  it('passes data parts of a delegated run to its stream', async () => {
    const scripted = scriptedBackend([
      callTools([{ id: 'c1', name: 'helper', arguments: { task: 'chart it' } }]),
      callTools([{ id: 'c2', name: 'chart', arguments: {} }]),
      answer('Charted'),
      answer('Done'),
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: scripted.backend } } });
    const chart = tool({
      name: 'chart',
      description: 'Draws',
      parameters: z.object({}),
      execute: async (_args, context) => {
        context.data?.({ id: 'chart_1', name: 'chart', data: [1, 2] });
        return 'drawn';
      },
    });
    const helper = new Agent({
      name: 'helper',
      description: 'Draws charts',
      model: 'mock/m',
      instructions: 'Draw.',
      tools: [chart],
    });
    const lead = new Agent({
      name: 'lead',
      model: 'mock/m',
      instructions: 'Lead.',
      tools: [agentAsTool(cog, helper, { name: 'helper', description: 'Draws charts' })],
    });
    const parent: RunDataPart[] = [];
    const child: Array<[string, RunDataPart]> = [];

    await cog.run(lead, {
      input: 'Go',
      onData: (part) => parent.push(part),
      onDelegatedRun: (start: DelegatedRunStart) => ({
        onData: (part) => child.push([start.agent, part]),
      }),
    });

    expect(parent).toEqual([]);
    expect(child).toEqual([
      ['helper', expect.objectContaining({ id: 'chart_1', name: 'chart', toolCallId: 'c2' })],
    ]);
  });
});
