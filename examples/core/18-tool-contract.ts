import { header, section } from '../_shared/setup.js';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  isProviderSafeToolName,
  normalizeToolName,
  tool,
  toolContent,
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

async function main() {
  header('18 - Tool contract: names, result parts, result size, cancelling a sandboxed call');

  if (!(await ollamaIsUp())) {
    console.error(`  Ollama is not answering at ${OLLAMA_URL}.`);
    console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
    process.exit(1);
  }

  section('Tool names every provider accepts');
  try {
    tool({
      name: 'orders.lookup',
      description: 'Look up an order',
      parameters: z.object({}),
      execute: async () => null,
    });
  } catch (error) {
    console.log(`tool() refuses the name: ${(error as Error).message}`);
  }
  const fromData = normalizeToolName('Order Lookup (v2)');
  console.log(`normalizeToolName gives "${fromData}", safe: ${isProviderSafeToolName(fromData)}`);

  const cog = new Cogitator({
    llm: { providers: { ollama: { baseUrl: OLLAMA_URL } }, retry: false },
    limits: { maxToolResultLength: 2_000 },
  });

  section('json and resource parts');
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Look up an order by its id and return its details',
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }) =>
      toolContent(
        { type: 'json', value: { id, status: 'shipped', carrier: 'DHL' } },
        {
          type: 'resource',
          uri: `file:///orders/${id}.md`,
          mediaType: 'text/markdown',
          text: 'Handle with care: the parcel is fragile.',
        }
      ),
  });
  const support = new Agent({
    name: 'support',
    model: `ollama/${MODEL}`,
    instructions: 'You answer questions about orders. Always call lookup_order first.',
    tools: [lookupOrder],
    maxIterations: 3,
  });
  const answer = await cog.run(support, {
    input: 'Which carrier ships order A-17? Call lookup_order with id "A-17".',
  });
  const toolMessage = answer.messages.find((message) => message.role === 'tool');
  console.log(`The model read:\n${String(toolMessage?.content ?? '(no tool call)')}`);
  console.log(`Answer: ${answer.output.trim()}`);

  section('A result longer than limits.maxToolResultLength');
  const readLog = tool({
    name: 'read_log',
    description: 'Read the deploy log',
    parameters: z.object({}),
    execute: async () => `${'step ok\n'.repeat(5_000)}deploy finished: 3 warnings`,
  });
  const ops = new Agent({
    name: 'ops',
    model: `ollama/${MODEL}`,
    instructions: 'Always call read_log first.',
    tools: [readLog],
    maxIterations: 3,
  });
  let fullLength = 0;
  let sent: unknown;
  let logAnswer = '';
  for (let attempt = 0; attempt < 3 && typeof sent !== 'string'; attempt++) {
    const logRun = await cog.run(ops, {
      input: 'How did the deploy end?',
      onToolResult: (result) => (fullLength = String(result.result).length),
    });
    sent = logRun.messages.find((message) => message.role === 'tool')?.content;
    logAnswer = logRun.output.trim();
  }
  if (typeof sent === 'string') {
    console.log(`The application got ${fullLength} characters, the model read ${sent.length}:`);
    console.log(sent.slice(sent.indexOf('[...'), sent.indexOf('...]') + 4));
    console.log(`Answer: ${logAnswer}`);
  } else {
    console.log('The model answered without calling read_log, run the example again.');
  }

  section('Cancelling a run stops its sandboxed command');
  const shell = tool({
    name: 'shell',
    description: 'Run a shell command',
    parameters: z.object({ command: z.string() }),
    sandbox: { type: 'docker', image: 'alpine:3.19' },
    execute: async ({ command }) => command,
  });
  const runner = new Agent({
    name: 'runner',
    model: `ollama/${MODEL}`,
    instructions: 'Always call the shell tool with the command the user gives.',
    tools: [shell],
    maxIterations: 2,
  });
  const controller = new AbortController();
  const started = Date.now();
  try {
    await cog.run(runner, {
      input: 'Run this command: sleep 20',
      signal: controller.signal,
      onToolCall: (call) => {
        console.log(`Model called ${call.name}, cancelling the run in 500 ms`);
        setTimeout(() => controller.abort(new Error('The user cancelled')), 500);
      },
    });
    console.log('The model answered without calling the tool this time.');
  } catch (error) {
    console.log(`Run stopped after ${Date.now() - started} ms: ${(error as Error).message}`);
  }

  await cog.close();
  console.log('\nDone.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
