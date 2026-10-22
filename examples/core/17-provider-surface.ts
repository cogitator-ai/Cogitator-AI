import { header, section } from '../_shared/setup.js';
import {
  Agent,
  Cogitator,
  LLMError,
  OPENAI_COMPATIBLE_PROFILES,
  OllamaBackend,
  reasoningEffortFor,
  resolveOpenAICompatibleProfile,
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
  header('17 - Provider surface: pricing, server profiles, error kinds');

  if (!(await ollamaIsUp())) {
    console.error(`  Ollama is not answering at ${OLLAMA_URL}.`);
    console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
    process.exit(1);
  }

  const cog = new Cogitator({
    llm: {
      providers: {
        ollama: {
          baseUrl: OLLAMA_URL,
          headers: { 'X-Example': '17-provider-surface' },
        },
        openai: {
          apiKey: 'ollama',
          baseUrl: `${OLLAMA_URL}/v1`,
          profile: { server: 'ollama', reasoningEffort: false },
          headers: { 'X-Example': '17-provider-surface' },
        },
      },
      pricing: {
        [MODEL]: { input: 0.1, output: 0.4 },
      },
      retry: false,
    },
  });

  section('llm.pricing: a price of your own for a model the catalogue does not list');
  const priced = new Agent({
    name: 'priced',
    model: `ollama/${MODEL}`,
    instructions: 'Answer in one short sentence.',
    maxIterations: 1,
  });
  const result = await cog.run(priced, { input: 'What is the capital of France?' });
  console.log(`Answer: ${result.output.trim()}`);
  console.log(
    `Usage: ${result.usage.inputTokens} in, ${result.usage.outputTokens} out, cost $${result.usage.cost.toFixed(8)}`
  );
  console.log(`cog.pricer.pricing('ollama/${MODEL}'):`, cog.pricer.pricing(`ollama/${MODEL}`));
  console.log(
    `The key '${MODEL}' also prices 'openai/${MODEL}':`,
    cog.pricer.pricing(`openai/${MODEL}`) !== null
  );

  section('An OpenAI-compatible server with its profile (Ollama /v1)');
  const compatible = new Agent({
    name: 'compatible',
    model: `openai/${MODEL}`,
    instructions: 'Answer in one word.',
    maxIterations: 1,
  });
  let streamed = '';
  const viaCompat = await cog.run(compatible, {
    input: 'Name a primary color.',
    stream: true,
    onToken: (token) => {
      streamed += token;
    },
  });
  console.log(`Streamed: ${streamed.trim()}`);
  console.log(
    `Usage from the stream: ${viaCompat.usage.inputTokens} in, ${viaCompat.usage.outputTokens} out, cost $${viaCompat.usage.cost.toFixed(8)}`
  );

  const mistral = resolveOpenAICompatibleProfile('generic', 'mistral');
  console.log('Mistral preset:', mistral);
  console.log(
    `reasoning.effort 'xhigh' on Mistral is sent as '${reasoningEffortFor(mistral, 'xhigh')}'`
  );
  console.log(
    `reasoning.effort 'medium' on DeepSeek is sent as '${reasoningEffortFor(OPENAI_COMPATIBLE_PROFILES.deepseek, 'medium')}'`
  );

  section('error.kind: why a call failed');
  const missing = new Agent({
    name: 'missing',
    model: 'ollama/no-such-model-cogitator-example:latest',
    instructions: 'Answer briefly.',
    maxIterations: 1,
  });
  try {
    await cog.run(missing, { input: 'Hello' });
  } catch (error) {
    if (error instanceof LLMError) {
      console.log(
        `Model not pulled: code ${error.code}, kind ${error.kind}, retryable ${error.retryable}, HTTP ${error.details?.statusCode}`
      );
    } else {
      throw error;
    }
  }

  const unreachable = new OllamaBackend({ baseUrl: 'http://127.0.0.1:9' });
  try {
    await unreachable.chat({ model: MODEL, messages: [{ role: 'user', content: 'Hello' }] });
  } catch (error) {
    if (error instanceof LLMError) {
      console.log(
        `Server down: code ${error.code}, kind ${error.kind}, retryable ${error.retryable}`
      );
    } else {
      throw error;
    }
  }

  const backend = new OllamaBackend({ baseUrl: OLLAMA_URL });
  const controller = new AbortController();
  const reason = new Error('The user closed the page');
  try {
    for await (const chunk of backend.chatStream({
      model: MODEL,
      messages: [{ role: 'user', content: 'Count from 1 to 100, one number per line.' }],
      signal: controller.signal,
    })) {
      if (chunk.delta.content) controller.abort(reason);
    }
  } catch (error) {
    console.log(`Aborted stream fails with the abort reason: ${error === reason}`);
  }

  await cog.close();
  console.log('\nDone.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
