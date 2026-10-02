import { serveMCPTools } from '@cogitator-ai/mcp';
import { z } from 'zod';

function defineTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    execute,
    toJSON: () => ({
      name,
      description,
      parameters: z.toJSONSchema(parameters),
    }),
  };
}

const add = defineTool(
  'add',
  'Add two numbers and return their sum.',
  z.object({ a: z.number(), b: z.number() }),
  async ({ a, b }) => ({ sum: a + b })
);

const fail = defineTool(
  'fail',
  'Always fails.',
  z.object({ reason: z.string() }),
  async ({ reason }) => {
    throw new Error(reason);
  }
);

await serveMCPTools([add, fail], {
  name: 'e2e-stdio-server',
  version: '1.0.0',
  transport: 'stdio',
  logging: true,
});
