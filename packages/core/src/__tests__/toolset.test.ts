import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Agent } from '../agent';
import { tool, toolset } from '../tool';
import { createToolContext } from './helpers/tool-context';

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  parameters: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => a + b,
});

const shout = tool({
  name: 'shout',
  description: 'Upper-case a text',
  parameters: z.object({ text: z.string() }),
  execute: async ({ text }) => text.toUpperCase(),
});

describe('toolset', () => {
  it('keeps each tool typed and works as an array of tools', async () => {
    const tools = toolset(add, shout);
    const [sum, loud] = tools;

    const total: number = await sum.execute({ a: 2, b: 3 }, createToolContext());
    const text: string = await loud.execute({ text: 'hi' }, createToolContext());

    expect(total).toBe(5);
    expect(text).toBe('HI');
    expect(new Agent({ name: 'calc', instructions: 'x', tools }).tools.map((t) => t.name)).toEqual([
      'add',
      'shout',
    ]);
  });
});
