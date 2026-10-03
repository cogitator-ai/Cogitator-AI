import type { Section } from './types';

export const advanced: Section = {
  id: 'advanced',
  title: 'Advanced',
  icon: '🧬',
  description:
    'Agents that extend themselves, logic programming, constraint solving, verified plans and WASM-sandboxed tools.',
  recipes: [
    {
      id: 'self-modifying',
      title: 'Self-Modifying Agent',
      difficulty: 'advanced',
      time: '20 min',
      problem:
        'The agent is asked for something none of its tools can do. It should notice the gap and generate a sandboxed tool, within safety limits.',
      points: [
        'Find missing capabilities with `GapAnalyzer`',
        'Check changes against constraints with `ModificationValidator`',
        'Run `SelfModifyingAgent` with tool generation and meta-reasoning',
      ],
      file: 'self-modifying.ts',
      code: `import { Agent, createLLMBackend, tool } from '@cogitator-ai/core';
import {
  DEFAULT_CAPABILITY_CONSTRAINTS,
  DEFAULT_RESOURCE_CONSTRAINTS,
  DEFAULT_SAFETY_CONSTRAINTS,
  GapAnalyzer,
  ModificationValidator,
  SelfModifyingAgent,
} from '@cogitator-ai/self-modifying';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const llm = createLLMBackend('google', { providers: { google: { apiKey } } });

const fetchWeather = tool({
  name: 'fetch_weather',
  description: 'Fetch current weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, temperature: 22, condition: 'partly cloudy', windKph: 18 }),
});

const agent = new Agent({
  name: 'adaptive-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You fetch weather data. When you lack a tool for a task, say what is missing.',
  tools: [fetchWeather],
  temperature: 0.3,
  maxIterations: 5,
});

const toolGeneration = {
  enabled: true,
  autoGenerate: true,
  maxToolsPerSession: 2,
  minConfidenceForGeneration: 0.6,
  maxIterationsPerTool: 2,
  requireLLMValidation: false,
  sandboxConfig: {
    enabled: true,
    maxExecutionTime: 5000,
    maxMemory: 50 * 1024 * 1024,
    allowedModules: [],
    isolationLevel: 'strict' as const,
  },
};

const gaps = await new GapAnalyzer({ llm, model: 'gemini-3.5-flash-lite', config: toolGeneration }).analyze(
  'Calculate the wind chill for Tokyo and convert it to Fahrenheit',
  [fetchWeather]
);
for (const gap of gaps.gaps) {
  console.log(\`missing: \${gap.suggestedToolName} — \${gap.description} (\${(gap.confidence * 100).toFixed(0)}%)\`);
}

const validator = new ModificationValidator({
  constraints: {
    safety: DEFAULT_SAFETY_CONSTRAINTS,
    capability: DEFAULT_CAPABILITY_CONSTRAINTS,
    resource: DEFAULT_RESOURCE_CONSTRAINTS,
  },
});
const check = await validator.validate({
  type: 'config_change',
  target: 'architecture',
  changes: { temperature: 0.5 },
  reason: 'More creative answers',
});
console.log('modification allowed:', check.valid);

const selfModifying = new SelfModifyingAgent({
  agent,
  llm,
  config: {
    toolGeneration,
    metaReasoning: { enabled: true },
    architectureEvolution: { enabled: false },
    constraints: { enabled: true, autoRollback: true },
  },
});

selfModifying.on('tool_generation_completed', (event) => {
  console.log(\`generated \${event.data.name}: \${event.data.success ? 'ok' : 'failed'}\`);
});

const result = await selfModifying.run('What is the wind chill in Tokyo, in Fahrenheit?');
console.log(result.output);
console.log('tools generated:', result.toolsGenerated.length, 'adaptations:', result.adaptationsMade.length);`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/self-modifying zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx self-modifying.ts',
      repoRun: 'npx tsx examples/advanced/01-self-modifying.ts',
      example: 'advanced/01-self-modifying.ts',
      docs: [
        {
          href: '/docs/advanced/self-modifying',
          label: 'Self-Modifying Agents',
        },
      ],
    },
    {
      id: 'logic-programming',
      title: 'Logic Programming',
      difficulty: 'advanced',
      time: '10 min',
      problem:
        'Some answers must be derived by rules, not guessed: family relations, pricing tiers, discounts.',
      points: [
        'Load Prolog-style facts and rules with `createKnowledgeBase()`',
        'Query with `queryKnowledgeBase()`, add facts with `assert()`',
        'Use arithmetic, cut and `findall`',
      ],
      file: 'logic-programming.ts',
      code: `import { createKnowledgeBase, formatSolutions, queryKnowledgeBase } from '@cogitator-ai/neuro-symbolic';

const kb = createKnowledgeBase();

const loaded = kb.consult(\`
  parent(tom, bob).
  parent(tom, liz).
  parent(bob, ann).
  parent(bob, pat).
  parent(pat, jim).
  male(tom).
  male(bob).
  female(pat).

  father(X, Y) :- parent(X, Y), male(X).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
  ancestor(X, Y) :- parent(X, Y).
  ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
\`);
if (!loaded.success) throw new Error(\`Parse errors: \${JSON.stringify(loaded.errors)}\`);

for (const query of ['father(X, bob)', 'grandparent(tom, X)', 'ancestor(tom, X)']) {
  console.log(\`\${query} => \${formatSolutions(queryKnowledgeBase(kb, query))}\`);
}

kb.assert('parent(jim, sam).');
console.log('Is Tom an ancestor of Sam?', queryKnowledgeBase(kb, 'ancestor(tom, sam)').success);

const pricing = createKnowledgeBase(\`
  price(laptop, 1200).
  price(mouse, 25).
  price(monitor, 300).
  discount(Total, D) :- ( Total >= 1000 -> D is Total * 0.1 ; D = 0 ).
  tier(P, premium) :- P >= 1000, !.
  tier(P, standard) :- P >= 100, !.
  tier(_, budget).
\`);

console.log(formatSolutions(queryKnowledgeBase(pricing, 'findall(P, price(_, P), Ps), sum_list(Ps, Total), discount(Total, D)')));
console.log(formatSolutions(queryKnowledgeBase(pricing, 'price(Item, P), tier(P, Tier)')));`,
      install: 'pnpm add @cogitator-ai/neuro-symbolic',
      env: [],
      run: 'npx tsx logic-programming.ts',
      repoRun: 'npx tsx examples/advanced/02-neuro-symbolic.ts',
      example: 'advanced/02-neuro-symbolic.ts',
      docs: [
        {
          href: '/docs/advanced/neuro-symbolic',
          label: 'Neuro-Symbolic',
        },
      ],
    },
    {
      id: 'constraint-solving',
      title: 'Constraint Solving',
      difficulty: 'advanced',
      time: '10 min',
      problem:
        'Schedule meetings so nothing overlaps, and find the cheapest staffing that covers every shift.',
      points: [
        'Declare variables and constraints with `ConstraintBuilder`',
        'Solve with the built-in solver, or optimize with Z3 when it is installed',
      ],
      file: 'constraint-solving.ts',
      code: `import { ConstraintBuilder, allDifferent, createNeuroSymbolic, isZ3Available, solveSAT } from '@cogitator-ai/neuro-symbolic';

const schedule = ConstraintBuilder.create('meeting-rooms');
const engineering = schedule.int('engineering', 0, 3);
const product = schedule.int('product', 0, 3);
const design = schedule.int('design', 0, 3);
const marketing = schedule.int('marketing', 0, 3);

schedule.assert(allDifferent(engineering, product, design, marketing), 'one team per slot');
schedule.assert(engineering.lt(product), 'engineering before product');
schedule.assert(design.neq(0), 'design not in the first slot');
schedule.assert(marketing.gt(engineering), 'marketing after engineering');

const slots = ['9:00', '10:00', '11:00', '13:00'];
const solved = solveSAT(schedule.build(), { timeout: 5000, maxIterations: 5000 });
if (solved.status === 'sat' && solved.model) {
  for (const [team, slot] of Object.entries(solved.model.assignments)) {
    console.log(\`\${slots[slot as number]} \${team}\`);
  }
}

const ns = createNeuroSymbolic();
const staffing = ns.createConstraintProblem('staffing');
const seniors = staffing.int('seniors', 0, 10);
const juniors = staffing.int('juniors', 0, 10);
staffing.assert(seniors.add(juniors).gte(8), 'cover 8 shifts');
staffing.assert(seniors.mul(2).gte(juniors), 'one senior per two juniors');
staffing.minimize(seniors.mul(300).add(juniors.mul(180)));

const optimal = await ns.solve(staffing.build());
console.log(\`solver: \${(await isZ3Available()) ? 'Z3' : 'built-in'}\`);
if (optimal.data?.status === 'sat') {
  const { assignments, objectiveValue } = optimal.data.model;
  console.log(\`hire \${assignments.seniors} seniors and \${assignments.juniors} juniors, cost \${objectiveValue}\`);
}`,
      install: 'pnpm add @cogitator-ai/neuro-symbolic',
      env: [],
      run: 'npx tsx constraint-solving.ts',
      repoRun: 'npx tsx examples/advanced/02-neuro-symbolic.ts',
      example: 'advanced/02-neuro-symbolic.ts',
      docs: [
        {
          href: '/docs/advanced/neuro-symbolic',
          label: 'Neuro-Symbolic',
        },
      ],
    },
    {
      id: 'plan-verification',
      title: 'Plan Verification',
      difficulty: 'advanced',
      time: '10 min',
      problem:
        'Before an agent executes a plan, check that every step’s preconditions hold and the goal is reached.',
      points: [
        'Describe actions with `ActionSchemaBuilder`',
        'Validate and simulate plans with `validatePlan()` and `simulatePlan()`',
      ],
      file: 'plan-verification.ts',
      code: `import {
  ActionRegistry,
  ActionSchemaBuilder,
  createAction,
  formatValidationResult,
  simulatePlan,
  validatePlan,
} from '@cogitator-ai/neuro-symbolic';
import type { Plan } from '@cogitator-ai/types';

const registry = new ActionRegistry();

registry.register(
  ActionSchemaBuilder.create('load_package')
    .describe('Load the package onto the truck at the warehouse')
    .preSimple('package', 'warehouse')
    .preSimple('truck', 'warehouse')
    .assign('package', 'on_truck')
    .setCost(1)
    .build()
);
registry.register(
  ActionSchemaBuilder.create('drive_to_store')
    .describe('Drive the truck from the warehouse to the store')
    .preSimple('truck', 'warehouse')
    .assign('truck', 'store')
    .setCost(3)
    .build()
);
registry.register(
  ActionSchemaBuilder.create('unload_package')
    .describe('Unload the package at the store')
    .preSimple('package', 'on_truck')
    .preSimple('truck', 'store')
    .assign('package', 'store')
    .setCost(1)
    .build()
);

const plan: Plan = {
  id: 'delivery-1',
  name: 'deliver-package',
  initialState: { id: 'start', variables: { package: 'warehouse', truck: 'warehouse' } },
  actions: [
    createAction('load_package', {}),
    createAction('drive_to_store', {}),
    createAction('unload_package', {}),
  ],
  goalConditions: [{ type: 'simple', variable: 'package', value: 'store' }],
};

console.log(formatValidationResult(validatePlan(plan, registry)));

const simulation = simulatePlan(plan, registry);
console.log('reaches goal:', simulation.success, simulation.finalState.variables);

const broken: Plan = { ...plan, id: 'delivery-2', actions: [plan.actions[1], plan.actions[0], plan.actions[2]] };
console.log(formatValidationResult(validatePlan(broken, registry)));`,
      install: 'pnpm add @cogitator-ai/neuro-symbolic @cogitator-ai/types',
      env: [],
      run: 'npx tsx plan-verification.ts',
      repoRun: 'npx tsx examples/advanced/02-neuro-symbolic.ts',
      example: 'advanced/02-neuro-symbolic.ts',
      docs: [
        {
          href: '/docs/advanced/neuro-symbolic',
          label: 'Neuro-Symbolic',
        },
      ],
    },
    {
      id: 'wasm-tools',
      title: 'WASM-Sandboxed Tools',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'You want math, hashing, JSON queries and validation done by tools that cannot touch the host.',
      points: ['Run the pre-built WASM tools directly or give them to an agent'],
      file: 'wasm-tools.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import {
  createBase64Tool,
  createCalcTool,
  createHashTool,
  createJsonTool,
  createValidationTool,
} from '@cogitator-ai/wasm-tools';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const calc = createCalcTool();
const hash = createHashTool();
const json = createJsonTool();

const context = { agentId: 'example', runId: 'direct', signal: AbortSignal.timeout(30_000) };
console.log(await calc.execute({ expression: '(2 + 3) * 4' }, context));
console.log(await hash.execute({ text: 'cogitator', algorithm: 'sha256' }, context));
console.log(await json.execute({ json: '{"users":[{"n":"a"},{"n":"b"}]}', query: '$.users[*].n' }, context));

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const agent = new Agent({
  name: 'data-processor',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You process data with sandboxed WASM tools. Show results clearly.',
  tools: [calc, hash, json, createBase64Tool(), createValidationTool()],
  temperature: 0.2,
  maxIterations: 15,
});

const result = await cog.run(agent, {
  input: \`Validate "user@example.com" as an email, base64-encode it, and hash "Alice" with sha256.\`,
});
console.log(result.output);
console.log('Tools:', result.toolCalls.map((call) => call.name).join(', '));

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/wasm-tools',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx wasm-tools.ts',
      repoRun: 'npx tsx examples/advanced/03-wasm-tools.ts',
      example: 'advanced/03-wasm-tools.ts',
      docs: [
        {
          href: '/docs/tools/wasm-tools',
          label: 'WASM Tools',
        },
      ],
    },
  ],
};
