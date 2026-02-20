import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import {
  Agent,
  AgentOptimizer,
  InMemoryTraceStore,
  createLLMBackend,
  tool,
} from '@cogitator-ai/core';
import { z } from 'zod';

const triviaDb: Record<string, string> = {
  'What is the capital of France?': 'Paris',
  'Who wrote "1984"?': 'George Orwell',
  'What planet is closest to the Sun?': 'Mercury',
  'What is the chemical symbol for gold?': 'Au',
  'In what year did the Titanic sink?': '1912',
};

const checkAnswer = tool({
  name: 'check_answer',
  description: 'Check if an answer to a trivia question is correct',
  parameters: z.object({
    question: z.string().describe('The trivia question'),
    answer: z.string().describe('The proposed answer'),
  }),
  execute: async ({ question, answer }) => {
    const correct = triviaDb[question];
    if (!correct) {
      return { found: false, question };
    }
    const isCorrect = answer.toLowerCase().includes(correct.toLowerCase());
    return { correct: isCorrect, expected: correct, given: answer };
  },
});

const questions = Object.keys(triviaDb);

async function main() {
  header('07 — Agent Optimizer');

  const cog = createCogitator();

  const llm = createLLMBackend('google', {
    defaultProvider: 'google',
    providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } },
  });

  const traceStore = new InMemoryTraceStore();

  const optimizer = new AgentOptimizer({
    llm,
    model: 'gemini-2.5-flash',
    traceStore,
  });

  const agent = new Agent({
    name: 'trivia-bot',
    model: DEFAULT_MODEL,
    instructions: `You are a trivia bot. When asked a question:
1. Think of the answer
2. Use check_answer to verify it
3. Always reply with a clear text response stating whether you got it right and what the answer is`,
    tools: [checkAnswer],
    temperature: 0.3,
    maxIterations: 5,
  });

  section('1. Capturing traces from multiple runs');

  for (let i = 0; i < 3; i++) {
    const q = questions[i];
    console.log(`  Run ${i + 1}: "${q}"`);

    const result = await cog.run(agent, { input: q });

    const trace = await optimizer.captureTrace(result, q, {
      expected: triviaDb[q],
      labels: ['trivia', `round-1`],
    });

    console.log(`    Output: ${result.output.slice(0, 100)}`);
    console.log(`    Score:  ${trace.score.toFixed(2)}`);
    console.log(`    Tools:  ${result.toolCalls.map((tc) => tc.name).join(', ') || 'none'}`);
  }

  section('2. Trace store stats');

  const stats = await optimizer.getStats(agent.id);
  console.log(`  Total traces:    ${stats.traces.totalTraces}`);
  console.log(`  Average score:   ${stats.traces.averageScore.toFixed(2)}`);
  console.log(`  Demo count:      ${stats.traces.demoCount}`);

  section('3. Running optimization (compile)');

  const trainset = questions.slice(0, 3).map((q) => ({
    input: q,
    expected: triviaDb[q],
  }));

  const optimizationResult = await optimizer.compile(agent, trainset, {
    maxRounds: 2,
    maxBootstrappedDemos: 3,
  });

  console.log(`  Success:            ${optimizationResult.success}`);
  console.log(`  Score before:       ${optimizationResult.scoreBefore.toFixed(2)}`);
  console.log(`  Score after:        ${optimizationResult.scoreAfter.toFixed(2)}`);
  console.log(`  Improvement:        ${optimizationResult.improvement.toFixed(3)}`);
  console.log(`  Traces evaluated:   ${optimizationResult.tracesEvaluated}`);
  console.log(`  Bootstrap rounds:   ${optimizationResult.bootstrapRounds}`);
  console.log(`  Demos added:        ${optimizationResult.demosAdded.length}`);
  console.log(`  Duration:           ${optimizationResult.duration}ms`);

  if (optimizationResult.errors.length > 0) {
    console.log(`  Errors:`);
    for (const err of optimizationResult.errors) {
      console.log(`    - ${err.slice(0, 120)}`);
    }
  }

  section('4. Instructions comparison');

  const before = optimizationResult.instructionsBefore ?? agent.instructions;
  const after = optimizationResult.instructionsAfter ?? before;

  console.log(`  BEFORE (${before.length} chars):`);
  console.log(`    "${before.slice(0, 200)}${before.length > 200 ? '...' : ''}"`);
  console.log();
  console.log(`  AFTER (${after.length} chars):`);
  console.log(`    "${after.slice(0, 200)}${after.length > 200 ? '...' : ''}"`);

  const changed = before !== after;
  console.log(`\n  Instructions changed: ${changed}`);

  section('5. Bootstrapped demos');

  const demos = await optimizer.bootstrapDemos(agent.id);
  console.log(`  Total demos: ${demos.length}`);

  for (const demo of demos.slice(0, 3)) {
    console.log(`  [${demo.id}] score=${demo.score.toFixed(2)} keySteps=${demo.keySteps.length}`);
    console.log(`    Input:  "${demo.input.slice(0, 80)}"`);
    console.log(`    Output: "${demo.output.slice(0, 80)}"`);
  }

  if (demos.length > 0) {
    const formatted = optimizer.formatDemosForPrompt(demos.slice(0, 2));
    console.log(`\n  Formatted prompt (${formatted.length} chars):`);
    const lines = formatted.split('\n').slice(0, 8);
    for (const line of lines) {
      console.log(`    ${line}`);
    }
    if (formatted.split('\n').length > 8) {
      console.log(`    ...`);
    }
  }

  await cog.close();
  console.log('\nDone.');
}

main();
