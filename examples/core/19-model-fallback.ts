import { header, section } from '../_shared/setup.js';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { CogitatorError } from '@cogitator-ai/types';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const RETIRED = 'ollama/retired-model:7b';

async function ollamaIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  header('19 - Fallback models: keep answering when a model fails');

  if (!(await ollamaIsUp())) {
    console.error(`  Ollama is not answering at ${OLLAMA_URL}.`);
    console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
    process.exit(1);
  }

  const cog = new Cogitator({
    llm: {
      providers: { ollama: { baseUrl: OLLAMA_URL } },
      modelCircuitBreaker: { failureThreshold: 3, resetTimeout: 60_000 },
    },
  });

  const agent = new Agent({
    name: 'support',
    model: RETIRED,
    fallbackModels: [`ollama/${MODEL}`],
    instructions: 'Answer in one short sentence.',
  });

  section('The primary model is gone, the turn falls back');
  const first = await cog.run(agent, {
    input: 'What is a circuit breaker in software?',
    onModelFallback: ({ from, to, error }) => {
      const kind = error instanceof CogitatorError ? error.details?.kind : undefined;
      console.log(`  ${from} failed (${String(kind)}), moving to ${to}`);
    },
  });
  console.log(`  Answered by ${first.modelUsed}: ${first.output.trim()}`);

  section('Its breaker is open now, so the next run skips it at once');
  const started = Date.now();
  const second = await cog.run(agent, {
    input: 'And what is a fallback?',
    onModelFallback: ({ from, error }) => console.log(`  ${from} skipped: ${error.message}`),
  });
  console.log(`  Answered by ${second.modelUsed} in ${Date.now() - started} ms`);

  section('When no model answers, every failure is reported');
  const hopeless = new Agent({
    name: 'hopeless',
    model: RETIRED,
    fallbackModels: ['ollama/also-retired:3b'],
    instructions: 'Answer.',
  });
  try {
    await cog.run(hopeless, { input: 'Hello?' });
  } catch (error) {
    if (error instanceof CogitatorError) {
      console.log(`  ${error.code}`);
      const attempts = error.details?.attempts as { model: string; code?: string; kind?: string }[];
      for (const attempt of attempts) {
        console.log(`  - ${attempt.model}: ${attempt.kind ?? attempt.code}`);
      }
    }
  }

  await cog.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
