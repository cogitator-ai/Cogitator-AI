import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, toolToSchema } from '../tool';

describe('tool()', () => {
  it('creates a tool with required properties', () => {
    const calculator = tool({
      name: 'calculate',
      description: 'Perform a calculation',
      parameters: z.object({
        expression: z.string(),
      }),
      execute: ({ expression }) => Promise.resolve(eval(expression) as number),
    });

    expect(calculator.name).toBe('calculate');
    expect(calculator.description).toBe('Perform a calculation');
    expect(calculator.parameters).toBeDefined();
    expect(calculator.execute).toBeInstanceOf(Function);
  });

  it('creates a tool with optional properties', () => {
    const dangerousTool = tool({
      name: 'dangerous',
      description: 'A dangerous tool',
      parameters: z.object({ action: z.string() }),
      execute: () => Promise.resolve('done'),
      sideEffects: ['network', 'filesystem'],
      requiresApproval: true,
      timeout: 5000,
    });

    expect(dangerousTool.sideEffects).toEqual(['network', 'filesystem']);
    expect(dangerousTool.requiresApproval).toBe(true);
    expect(dangerousTool.timeout).toBe(5000);
  });

  it('executes the tool function correctly', async () => {
    const greet = tool({
      name: 'greet',
      description: 'Greet someone',
      parameters: z.object({
        name: z.string(),
      }),
      execute: ({ name }) => Promise.resolve(`Hello, ${name}!`),
    });

    const mockContext = {
      agentId: 'agent_test',
      runId: 'run_test',
      signal: new AbortController().signal,
    };
    const result = await greet.execute({ name: 'World' }, mockContext);
    expect(result).toBe('Hello, World!');
  });

  it('provides toJSON method that returns schema', () => {
    const myTool = tool({
      name: 'test',
      description: 'Test tool',
      parameters: z.object({
        input: z.string(),
      }),
      execute: () => Promise.resolve('result'),
    });

    const schema = myTool.toJSON();
    expect(schema.name).toBe('test');
    expect(schema.description).toBe('Test tool');
    expect(schema.parameters.type).toBe('object');
  });
});

describe('toolToSchema()', () => {
  it('converts a tool to JSON Schema format', () => {
    const myTool = tool({
      name: 'search',
      description: 'Search for something',
      parameters: z.object({
        query: z.string().describe('The search query'),
        limit: z.number().optional().describe('Max results'),
      }),
      execute: () => Promise.resolve([]),
    });

    const schema = toolToSchema(myTool);

    expect(schema.name).toBe('search');
    expect(schema.description).toBe('Search for something');
    expect(schema.parameters.type).toBe('object');
    expect(schema.parameters.properties).toHaveProperty('query');
    expect(schema.parameters.properties).toHaveProperty('limit');
    expect(schema.parameters.required).toContain('query');
    expect(schema.parameters.required).not.toContain('limit');
  });

  it('handles complex nested schemas', () => {
    const complexTool = tool({
      name: 'complex',
      description: 'Complex tool',
      parameters: z.object({
        user: z.object({
          name: z.string(),
          age: z.number(),
        }),
        tags: z.array(z.string()),
      }),
      execute: () => Promise.resolve(null),
    });

    const schema = toolToSchema(complexTool);

    expect(schema.parameters.properties).toHaveProperty('user');
    expect(schema.parameters.properties).toHaveProperty('tags');
  });
});
