import { header, section } from '../_shared/setup.js';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  isTripwire,
  tool,
  tripwire,
  type RunMiddleware,
} from '@cogitator-ai/core';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

async function ollamaIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

const orderStatus = tool({
  name: 'order_status',
  description: 'Status of an order by its id',
  parameters: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ id, status: id.startsWith('A') ? 'shipped' : 'packing' }),
});

const timing: RunMiddleware = {
  name: 'timing',
  async wrapModelCall(call, next) {
    const started = Date.now();
    const response = await next(call);
    console.log(`  [timing] ${call.model} answered in ${Date.now() - started} ms`);
    return response;
  },
};

const refundGuard: RunMiddleware = {
  name: 'refund-guard',
  beforeRun({ input }) {
    if (/\brefund\b/i.test(input)) tripwire('Refunds go to a person', { queue: 'billing' });
  },
};

const normalizeIds: RunMiddleware = {
  name: 'normalize-ids',
  wrapToolCall(call, next) {
    const id = String((call.args as { id: string }).id)
      .trim()
      .toUpperCase();
    console.log(`  [normalize-ids] ${call.toolCall.name}(${JSON.stringify(call.args)}) -> ${id}`);
    return next({ ...call, toolCall: { ...call.toolCall, arguments: { id } } });
  },
};

const noEmails: RunMiddleware = {
  name: 'no-emails',
  afterModel: ({ response }) => ({
    content: response.content.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email removed]'),
  }),
};

async function main() {
  header('21 - Run middleware: hooks around model and tool calls, tripwire guards');

  if (!(await ollamaIsUp())) {
    console.error(`  Ollama is not answering at ${OLLAMA_URL}.`);
    console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
    process.exit(1);
  }

  const cog = new Cogitator({
    llm: { providers: { ollama: { baseUrl: OLLAMA_URL } } },
    middleware: [timing, normalizeIds],
  });

  const agent = new Agent({
    name: 'orders',
    model: `ollama/${MODEL}`,
    instructions: 'You help with orders. Answer in one sentence.',
    tools: [orderStatus],
    middleware: [refundGuard, noEmails],
  });

  section('A run: timed by the Cogitator, emails removed by the agent');
  const result = await cog.run(agent, {
    input: 'In one sentence, tell me to write to support@shop.example about my order.',
  });
  console.log(`  ${result.output.trim()}`);

  section("A tool call through the Cogitator's middleware");
  const lookup = await cog.invokeTool(orderStatus, { id: ' a-17 ' });
  console.log(`  ${JSON.stringify(lookup.result)}`);

  section('A refund request trips the guard before any model call');
  try {
    await cog.run(agent, { input: 'I want a refund for order A-17' });
  } catch (error) {
    if (!isTripwire(error)) throw error;
    console.log(`  ${error.message} (${JSON.stringify(error.details.info)})`);
  }

  await cog.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
