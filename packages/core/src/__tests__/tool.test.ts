import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, toolToSchema, withParsedArguments } from '../tool';
import { Cogitator } from '../cogitator';

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

  it('does not require parameters that have a default', () => {
    const paged = tool({
      name: 'list',
      description: 'List items',
      parameters: z.object({ query: z.string(), limit: z.number().default(10) }),
      execute: () => Promise.resolve([]),
    });

    const schema = toolToSchema(paged);

    expect(schema.parameters.required).toEqual(['query']);
    expect(schema.parameters.properties.limit).toMatchObject({ default: 10 });
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

describe('tool metadata', () => {
  it('keeps title, outputSchema and annotations', () => {
    const outputSchema = z.object({ celsius: z.number() });
    const weather = tool({
      name: 'weather',
      title: 'Weather',
      description: 'Weather of a city',
      parameters: z.object({ city: z.string() }),
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: async () => ({ celsius: 20 }),
    });

    expect(weather.title).toBe('Weather');
    expect(weather.outputSchema).toBe(outputSchema);
    expect(weather.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(weather.toJSON().outputSchema).toMatchObject({
      type: 'object',
      properties: { celsius: { type: 'number' } },
    });
  });
});

describe('withParsedArguments()', () => {
  const double = tool({
    name: 'double',
    title: 'Double',
    description: 'Double a number',
    parameters: z.object({ count: z.string().transform((value) => Number(value)) }),
    requiresApproval: true,
    timeout: 1000,
    maxResultLength: 50,
    annotations: { idempotentHint: true },
    execute: async ({ count }) => count * 2,
  });

  it('keeps everything that decides how the call runs', () => {
    const parsed = withParsedArguments(double);
    expect(parsed).toMatchObject({
      name: 'double',
      title: 'Double',
      description: 'Double a number',
      requiresApproval: true,
      timeout: 1000,
      maxResultLength: 50,
      annotations: { idempotentHint: true },
    });
    expect(parsed.toJSON()).toEqual(double.toJSON());
  });

  it('runs already parsed arguments through invokeTool without parsing them again', async () => {
    const cogitator = new Cogitator();
    try {
      const result = await cogitator.invokeTool(
        withParsedArguments(double),
        { count: 21 },
        { onApproval: async () => ({ approved: true }) }
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toBe(42);

      const reparsed = await cogitator.invokeTool(
        double,
        { count: 21 },
        { onApproval: async () => ({ approved: true }) }
      );
      expect(reparsed.error).toBeDefined();
    } finally {
      await cogitator.close();
    }
  });
});
