import type { Section } from './types';

export const reasoning: Section = {
  id: 'reasoning',
  title: 'Reasoning & Learning',
  icon: '🧠',
  description:
    'Explore several solution paths, learn from past runs, replay and fork runs, reason about cause and effect.',
  recipes: [
    {
      id: 'tree-of-thought',
      title: 'Tree of Thoughts',
      difficulty: 'advanced',
      time: '15 min',
      problem:
        'A design question has many plausible answers. You want several branches explored and scored before committing to one.',
      points: [
        'Configure depth, branching and beam width on `ThoughtTreeExecutor`',
        'Read the best path and stats',
      ],
      file: 'tree-of-thought.ts',
      code: `import { Agent, Cogitator, ThoughtTreeExecutor } from '@cogitator-ai/core';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const architect = new Agent({
  name: 'architect',
  model: 'google/gemini-3.5-flash-lite',
  instructions: \`You are a senior software architect specializing in distributed systems.
Think through trade-offs: scalability, latency, consistency and operational complexity.
Be concrete about technologies, data structures and protocols.\`,
  temperature: 0.7,
  maxIterations: 5,
});

const tot = new ThoughtTreeExecutor(cog, {
  maxDepth: 2,
  branchFactor: 2,
  beamWidth: 2,
  confidenceThreshold: 0.2,
  terminationConfidence: 0.85,
  maxTotalNodes: 12,
  timeout: 120_000,
  onBranchEvaluated: (branch, score) =>
    console.log(\`[eval] \${branch.thought.slice(0, 60)}... -> \${score.composite.toFixed(2)}\`),
});

const result = await tot.explore(
  architect,
  'Design a caching strategy for a social media feed with 10M daily active users. ' +
    'Consider cache invalidation, personalization and cold start for new users.'
);

console.log(\`Explored \${result.stats.exploredNodes} nodes, pruned \${result.stats.prunedNodes}, \${result.stats.llmCalls} LLM calls\`);
for (const node of result.bestPath) {
  console.log(\`depth \${node.depth}: \${node.branch.thought.slice(0, 100)}\`);
}
console.log(result.output);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx tree-of-thought.ts',
      repoRun: 'npx tsx examples/core/05-tree-of-thought.ts',
      example: 'core/05-tree-of-thought.ts',
      docs: [
        {
          href: '/docs/advanced/reasoning',
          label: 'Reasoning',
        },
      ],
    },
    {
      id: 'reflection',
      title: 'Self-Reflection',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'The agent should notice its own mistakes — like an unknown ticker — and keep insights for next time.',
      points: [
        'Turn on `reflection` in the Cogitator config',
        'Read per-run `reflections`, stored insights and the summary',
      ],
      file: 'reflection.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const prices: Record<string, number> = { AAPL: 242.35, NVDA: 137.71, MSFT: 432.67 };

const getStockPrice = tool({
  name: 'get_stock_price',
  description: 'Get the current stock price for a ticker symbol',
  parameters: z.object({ ticker: z.string().describe('Stock ticker symbol, e.g. AAPL') }),
  execute: async ({ ticker }) => {
    const price = prices[ticker.toUpperCase()];
    return price
      ? { ticker, price, currency: 'USD' }
      : { error: \`Unknown ticker: \${ticker}. Available: \${Object.keys(prices).join(', ')}\` };
  },
});

const calculateReturn = tool({
  name: 'calculate_return',
  description: 'Calculate the return on investment given buy price, current price and shares',
  parameters: z.object({ buyPrice: z.number(), currentPrice: z.number(), shares: z.number() }),
  execute: async ({ buyPrice, currentPrice, shares }) => {
    const invested = buyPrice * shares;
    const profit = currentPrice * shares - invested;
    return { invested, profit, returnPercent: (profit / invested) * 100 };
  },
});

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  reflection: {
    enabled: true,
    reflectAfterToolCall: true,
    reflectAfterError: true,
    reflectAtEnd: true,
    storeInsights: true,
    minConfidenceToStore: 0.3,
    reflectionModel: 'google/gemini-3.5-flash-lite',
  },
});

const analyst = new Agent({
  name: 'portfolio-analyst',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a portfolio analyst. Use your tools to look up prices and calculate returns.',
  tools: [getStockPrice, calculateReturn],
  temperature: 0.3,
  maxIterations: 15,
});

const result = await cog.run(analyst, {
  input: 'I bought 50 AAPL at $185 and 30 ZZZZ at $95. What are my returns?',
});
console.log(result.output);

for (const reflection of result.reflections ?? []) {
  console.log(
    \`[\${reflection.action.type}] success=\${reflection.analysis.wasSuccessful} \` +
      \`confidence=\${reflection.analysis.confidence.toFixed(2)}: \${reflection.analysis.reasoning.slice(0, 100)}\`
  );
}

const insights = await cog.getInsights(analyst.id);
for (const insight of insights.slice(0, 5)) {
  console.log(\`insight [\${insight.type}] \${insight.content}\`);
}

const summary = await cog.getReflectionSummary(analyst.id);
if (summary) {
  console.log(\`success rate \${(summary.successRate * 100).toFixed(0)}%, learned:\`, summary.learnedPatterns);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx reflection.ts',
      repoRun: 'npx tsx examples/core/06-reflection.ts',
      example: 'core/06-reflection.ts',
      docs: [
        {
          href: '/docs/advanced/reflection',
          label: 'Reflection',
        },
      ],
    },
    {
      id: 'agent-optimizer',
      title: 'Optimize an Agent',
      difficulty: 'advanced',
      time: '20 min',
      problem:
        'You have examples of good answers and want the agent’s instructions and few-shot demos improved from them.',
      points: [
        'Capture scored traces with `AgentOptimizer.captureTrace()`',
        'Run `compile()` on a training set and compare scores and instructions',
      ],
      file: 'agent-optimizer.ts',
      code: `import { Agent, AgentOptimizer, Cogitator, InMemoryTraceStore, createLLMBackend, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const answers: Record<string, string> = {
  'What is the capital of France?': 'Paris',
  'Who wrote "1984"?': 'George Orwell',
  'What planet is closest to the Sun?': 'Mercury',
};

const checkAnswer = tool({
  name: 'check_answer',
  description: 'Check if an answer to a trivia question is correct',
  parameters: z.object({ question: z.string(), answer: z.string() }),
  execute: async ({ question, answer }) => {
    const correct = answers[question];
    if (!correct) return { found: false, question };
    return { correct: answer.toLowerCase().includes(correct.toLowerCase()), expected: correct };
  },
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const optimizer = new AgentOptimizer({
  llm: createLLMBackend('google', { providers: { google: { apiKey } } }),
  model: 'gemini-3.8-flash',
  traceStore: new InMemoryTraceStore(),
  cogitator: cog,
});

const agent = new Agent({
  name: 'trivia-bot',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a trivia bot. Answer, verify with check_answer, then state the answer clearly.',
  tools: [checkAnswer],
  temperature: 0.3,
  maxIterations: 5,
});

for (const [question, expected] of Object.entries(answers)) {
  const result = await cog.run(agent, { input: question });
  const trace = await optimizer.captureTrace(result, question, { expected, labels: ['trivia'] });
  console.log(\`\${question} -> score \${trace.score.toFixed(2)}\`);
}

const optimization = await optimizer.compile(
  agent,
  Object.entries(answers).map(([input, expected]) => ({ input, expected })),
  { maxRounds: 2, maxBootstrappedDemos: 3 }
);
console.log(\`score \${optimization.scoreBefore.toFixed(2)} -> \${optimization.scoreAfter.toFixed(2)}\`);
console.log('demos added:', optimization.demosAdded.length);
console.log('new instructions:', optimization.instructionsAfter ?? '(unchanged)');

const demos = await optimizer.bootstrapDemos(agent.id);
console.log(optimizer.formatDemosForPrompt(demos.slice(0, 2)));

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx agent-optimizer.ts',
      repoRun: 'npx tsx examples/core/07-agent-optimizer.ts',
      example: 'core/07-agent-optimizer.ts',
      docs: [
        {
          href: '/docs/advanced/learning',
          label: 'Learning',
        },
      ],
    },
    {
      id: 'time-travel',
      title: 'Time-Travel Debugging',
      difficulty: 'advanced',
      time: '15 min',
      problem:
        'A multi-step run went somewhere unexpected. You want to replay it from a step, or fork it with a different instruction and diff the paths.',
      points: [
        'Checkpoint every step with `TimeTravel`',
        'Replay, fork with new input and compare',
      ],
      file: 'time-travel.ts',
      code: `import { Agent, Cogitator, InMemoryCheckpointStore, TimeTravel, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const inventory: Record<string, number> = { wood: 100, stone: 80, iron: 30, gold: 5 };
const recipes: Record<string, Record<string, number>> = {
  wooden_sword: { wood: 10 },
  stone_pickaxe: { wood: 5, stone: 15 },
  iron_armor: { iron: 20, wood: 5 },
  gold_ring: { gold: 2 },
};

const checkInventory = tool({
  name: 'check_inventory',
  description: 'Check current inventory of materials',
  parameters: z.object({}),
  execute: async () => ({ ...inventory }),
});

const craft = tool({
  name: 'craft',
  description: 'Craft an item: wooden_sword, stone_pickaxe, iron_armor or gold_ring',
  parameters: z.object({ item: z.string() }),
  execute: async ({ item }) => {
    const recipe = recipes[item];
    if (!recipe) return { error: \`Unknown item: \${item}\` };
    for (const [material, amount] of Object.entries(recipe)) {
      if ((inventory[material] ?? 0) < amount) return { error: \`Not enough \${material}\` };
    }
    for (const [material, amount] of Object.entries(recipe)) inventory[material] -= amount;
    return { crafted: item, remaining: { ...inventory } };
  },
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const timeTravel = new TimeTravel(cog, { checkpointStore: new InMemoryCheckpointStore() });

const crafter = new Agent({
  name: 'crafter',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a game crafting assistant. Check inventory first, then craft what is asked.',
  tools: [checkInventory, craft],
  temperature: 0.2,
  maxIterations: 10,
});

const original = await cog.run(crafter, {
  input: 'Check our inventory, then craft a stone_pickaxe and a wooden_sword.',
});
console.log('Original path:', original.toolCalls.map((call) => call.name).join(' -> '));

const checkpoints = await timeTravel.checkpointAll(original, 'craft-session');
console.log(\`Saved \${checkpoints.length} checkpoints\`);

const replay = await timeTravel.replay(crafter, checkpoints[0].id, { mode: 'live' });
console.log(\`Replayed \${replay.stepsReplayed} steps, executed \${replay.stepsExecuted} new ones\`);

const fork = await timeTravel.forkWithNewInput(
  crafter,
  checkpoints[0].id,
  'Craft a gold_ring and an iron_armor instead. Check inventory first.',
  'alt-craft-path'
);
console.log('Fork path:', fork.result.toolCalls.map((call) => call.name).join(' -> '));

const diff = await timeTravel.compareWithOriginal(fork.result);
console.log(timeTravel.formatDiff(diff));

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx time-travel.ts',
      repoRun: 'npx tsx examples/core/08-time-travel.ts',
      example: 'core/08-time-travel.ts',
      docs: [
        {
          href: '/docs/advanced/time-travel',
          label: 'Time Travel',
        },
      ],
    },
    {
      id: 'causal-reasoning',
      title: 'Causal Reasoning',
      difficulty: 'advanced',
      time: '20 min',
      problem:
        'Churn went up after a redesign. You want to predict the effect of rolling it back and see the likely root causes.',
      points: [
        'Model causes, outcomes and confounders with `CausalGraphBuilder`',
        'Hand the graph to `CausalReasoner` through its graph store',
        'Predict effects, explain an outcome, generate hypotheses',
      ],
      file: 'causal-reasoning.ts',
      code: `import {
  CausalGraphBuilder,
  CausalReasoner,
  InMemoryCausalGraphStore,
  createLLMBackend,
} from '@cogitator-ai/core';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const graph = CausalGraphBuilder.create('user-retention')
  .treatment('redesign', 'UI Redesign')
  .causes('ux-complexity', { strength: 0.8, confidence: 0.9, mechanism: 'new navigation patterns' })
  .causes('page-load-time', { strength: 0.6, confidence: 0.7, mechanism: 'heavier assets' })
  .variable('ux-complexity', 'UX Complexity')
  .causes('user-frustration', { strength: 0.7, confidence: 0.85 })
  .variable('page-load-time', 'Page Load Time')
  .causes('bounce-rate', { strength: 0.8, confidence: 0.9 })
  .variable('user-frustration', 'User Frustration')
  .causes('churn', { strength: 0.9, confidence: 0.95 })
  .variable('bounce-rate', 'Bounce Rate')
  .causes('churn', { strength: 0.5, confidence: 0.8 })
  .outcome('churn', 'User Churn')
  .confounder('seasonality', 'Seasonality')
  .confounds('churn', { strength: 0.3, confidence: 0.5 })
  .build();

for (const node of graph.getNodes()) {
  const children = graph.getChildren(node.id).map((child) => child.id);
  console.log(\`[\${node.variableType}] \${node.name}\${children.length ? \` -> \${children.join(', ')}\` : ''}\`);
}

const agentId = 'product-analytics';
const graphStore = new InMemoryCausalGraphStore();
await graphStore.save({ ...graph.toData(), metadata: { agentId } });

const reasoner = new CausalReasoner({
  llmBackend: createLLMBackend('google', { providers: { google: { apiKey } } }),
  model: 'gemini-3.8-flash',
  graphStore,
  config: { enableLLMDiscovery: true, enableSafetyChecks: true },
});
await reasoner.loadGraph(agentId);

const prediction = await reasoner.predictEffect('Roll back the UI redesign', agentId, {
  observedVariables: { churn: 0.15, 'bounce-rate': 0.35 },
});
console.log(\`Prediction (\${prediction.confidence.toFixed(2)}): \${prediction.reasoning}\`);
for (const effect of prediction.effects) {
  console.log(\`  \${effect.variable}: \${effect.expectedValue} — \${effect.mechanism}\`);
}

const explanation = await reasoner.explainCause('churn', 0.15, agentId, {
  observedVariables: { 'ux-complexity': 0.8, 'page-load-time': 3.2, 'bounce-rate': 0.35 },
});
console.log(explanation.summary);
for (const cause of explanation.rootCauses) {
  console.log(\`  root cause \${cause.variable} (\${cause.contribution.toFixed(2)}): \${cause.suggestedIntervention ?? ''}\`);
}
for (const counterfactual of explanation.counterfactuals) {
  console.log(\`  if "\${counterfactual.change}" — would prevent: \${counterfactual.wouldPrevent}\`);
}

const hypotheses = await reasoner.generateHypotheses(agentId, 'reduce user churn');
for (const hypothesis of hypotheses.slice(0, 3)) {
  console.log(\`  hypothesis: \${hypothesis.cause} -> \${hypothesis.effect} (\${hypothesis.relationType})\`);
}`,
      install: 'pnpm add @cogitator-ai/core',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx causal-reasoning.ts',
      repoRun: 'npx tsx examples/core/12-causal-reasoning.ts',
      example: 'core/12-causal-reasoning.ts',
      docs: [
        {
          href: '/docs/advanced/causal-reasoning',
          label: 'Causal Reasoning',
        },
      ],
    },
  ],
};
