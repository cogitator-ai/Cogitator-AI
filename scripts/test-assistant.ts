import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { createInterface } from 'node:readline';
import { AssistantConfigSchema } from '../packages/config/src/index';
import { RuntimeBuilder } from '../packages/channels/src/runtime-builder';

function loadDotenv(env: Record<string, string | undefined>) {
  if (!existsSync('.env')) return;
  const content = readFileSync('.env', 'utf-8');
  for (const line of content.split('\n')) {
    const match = /^([^#=]+)=(.*)$/.exec(line);
    if (match) env[match[1].trim()] = match[2].trim();
  }
}

async function buildRuntime() {
  const configPath = ['cogitator.yml', 'cogitator.yaml'].find((f) => existsSync(f));
  if (!configPath) {
    console.error('No cogitator.yml found');
    process.exit(1);
  }

  const raw = parseYaml(readFileSync(configPath, 'utf-8'));
  const config = AssistantConfigSchema.parse(raw);

  const env = { ...process.env } as Record<string, string | undefined>;
  loadDotenv(env);

  console.log(`Building runtime for "${config.name}"...`);

  const resolvedPath = resolve(configPath);
  const builder = new RuntimeBuilder(config, env, {
    configPath: resolvedPath,
    configHelpers: {
      parseYaml,
      stringifyYaml: (o: unknown) => stringify(o, { lineWidth: 120 }),
      validateConfig: (o: unknown) => AssistantConfigSchema.parse(o),
    },
  });

  const runtime = await builder.build();
  console.log(
    `Runtime built. Agent: ${runtime.agent.name}, Model: ${config.llm.provider}/${config.llm.model}`
  );
  return runtime;
}

async function sendMessage(
  runtime: Awaited<ReturnType<typeof buildRuntime>>,
  input: string,
  threadId: string
) {
  console.log(`\n--- Sending: "${input}" ---`);

  const result = await runtime.cogitator.run(runtime.agent, {
    input,
    threadId,
    useMemory: true,
    onToolCall: (call) => {
      console.log(`  [tool] ${call.name}(${JSON.stringify(call.arguments).slice(0, 200)})`);
    },
    onToolResult: (res) => {
      const preview =
        typeof res.result === 'string'
          ? res.result.slice(0, 200)
          : JSON.stringify(res.result).slice(0, 200);
      console.log(`  [result] ${preview}`);
    },
  });

  console.log(`\n--- Response ---`);
  console.log(result.output);
  console.log(
    `\n  tokens: ${result.usage.totalTokens} | cost: $${result.usage.cost.toFixed(4)} | ${result.usage.duration}ms`
  );
  console.log(`  tool calls: ${result.toolCalls.length}`);
  return result;
}

async function main() {
  const runtime = await buildRuntime();
  const threadId = `test:${Date.now()}`;

  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] !== '--interactive') {
    try {
      for (const msg of args) {
        await sendMessage(runtime, msg, threadId);
      }
    } finally {
      await runtime.cleanup();
    }
    return;
  }

  console.log('Type messages to chat. Type /quit to exit.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    rl.question('You > ', async (input) => {
      if (!input.trim()) {
        prompt();
        return;
      }

      if (input.trim() === '/quit') {
        console.log('Shutting down...');
        await runtime.cleanup();
        rl.close();
        process.exit(0);
      }

      try {
        await sendMessage(runtime, input, threadId);
      } catch (err) {
        console.error('\nError:', err instanceof Error ? err.message : String(err));
        if (err instanceof Error && err.stack) {
          console.error(err.stack.split('\n').slice(1, 4).join('\n'));
        }
      }

      console.log();
      prompt();
    });
  };

  prompt();

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await runtime.cleanup();
    rl.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
