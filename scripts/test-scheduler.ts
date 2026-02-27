import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
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

async function main() {
  const configPath = ['cogitator.yml', 'cogitator.yaml'].find((f) => existsSync(f));
  if (!configPath) {
    console.error('No cogitator.yml found');
    process.exit(1);
  }

  const raw = parseYaml(readFileSync(configPath, 'utf-8'));
  const config = AssistantConfigSchema.parse(raw);

  const env = { ...process.env } as Record<string, string | undefined>;
  loadDotenv(env);

  console.log('Building runtime...');
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
  console.log('Runtime built.\n');

  console.log('Step 1: Scheduling a reminder for 10 seconds from now...');
  const threadId = `scheduler-test:${Date.now()}`;
  const result = await runtime.cogitator.run(runtime.agent, {
    input: 'Напомни мне через 10 секунд покормить кота',
    threadId,
    useMemory: true,
  });

  console.log('Agent response:', result.output);
  console.log(
    'Tool calls:',
    result.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`)
  );
  console.log();

  console.log('Step 2: Starting gateway (channels)...');
  await runtime.gateway.start();
  console.log('Gateway started. Scheduler polling every 30s.');
  console.log('Waiting up to 60s for scheduler to deliver...\n');

  const timeout = setTimeout(async () => {
    console.log('\nTIMEOUT: No delivery after 60s');
    await runtime.cleanup();
    process.exit(1);
  }, 60_000);

  const checkInterval = setInterval(async () => {
    process.stdout.write('.');
  }, 5000);

  // Scheduler will inject the message into gateway, which will try to send
  // through channels. If channel sends, we'd see it.
  // But since we might not have actual Telegram connected without polling,
  // let's just wait and see what happens.

  const origInject = runtime.gateway.injectMessage.bind(runtime.gateway);
  runtime.gateway.injectMessage = async (msg) => {
    console.log('\n\n=== SCHEDULER FIRED ===');
    console.log('Channel:', msg.channelType);
    console.log('User:', msg.userId);
    console.log('Input to LLM:', msg.text);
    console.log('========================\n');

    console.log('Running through LLM to generate reminder...');
    const reminderResult = await runtime.cogitator.run(runtime.agent, {
      input: msg.text,
      threadId: `reminder:${msg.userId}`,
      useMemory: false,
    });

    console.log('\n=== LLM REMINDER OUTPUT ===');
    console.log(reminderResult.output);
    console.log(
      `(tokens: ${reminderResult.usage.totalTokens}, cost: $${reminderResult.usage.cost.toFixed(4)})`
    );
    console.log('============================\n');

    clearInterval(checkInterval);
    clearTimeout(timeout);
    await runtime.cleanup();
    process.exit(0);
  };
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
