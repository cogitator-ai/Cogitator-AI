import { highlightCode } from '../../highlight';
import type { ExplorerFeature } from './types';

const SANDBOX_CODE = `
const sandbox = new SandboxManager({
  allowNativeFallback: false,
  defaults: {
    timeout: 5_000,
    resources: { memory: '128MB', cpus: 0.5, pidsLimit: 64 },
    network: { mode: 'none' },
  },
});

const run = await sandbox.execute(
  { command: ['python3', '-c', untrustedCode] },
  { type: 'docker', image: 'python:3.12-slim' }
);

const wasmTools = [createCalcTool(), createJsonTool(), createHashTool()];
`;

const SAFETY_CODE = `
const cog = new Cogitator({
  security: {
    pii: { mode: 'mask', detect: ['email', 'credit_card', 'phone'] },
    promptInjection: { action: 'block', threshold: 0.7 },
  },
  guardrails: {
    filterInput: true,
    filterOutput: true,
    filterToolCalls: true,
    enableCritiqueRevision: true,
  },
});
`;

const TRACE_CODE = `
const otlp = createOTLPExporter({ endpoint: process.env.OTLP_ENDPOINT!, enabled: true });
otlp.start();

const cog = new Cogitator({
  costRouting: { enabled: true, autoSelectModel: true, budget: { maxCostPerDay: 50 } },
});

let runId = '';
const result = await cog.run(agent, {
  input,
  onRunStart: (run) => (runId = run.runId),
  onSpan: (span) => otlp.exportSpan(runId, span),
});

console.log(result.modelUsed, result.usage.cost);
`;

const HANDOFF_CODE = `
const billing = new Agent({
  name: 'billing',
  description: 'Invoices, payments and refunds',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You are the billing specialist.',
  tools: [lookupInvoice],
});

const triage = new Agent({
  name: 'triage',
  model: 'openai/gpt-6-luna',
  instructions: 'Hand the conversation to the right specialist.',
  handoffs: [billing, support],
});

const result = await cog.run(triage, { input: 'How much do I owe on INV-204?' });
result.finalAgent;
`;

const REASONING_CODE = `
const tot = new ThoughtTreeExecutor(cog, {
  branchFactor: 3,
  beamWidth: 2,
  confidenceThreshold: 0.3,
  terminationConfidence: 0.85,
  onBacktrack: (from) => console.log('dead end at depth', from.depth),
});

const result = await tot.explore(architect, 'Design a cache for a 10M-user feed');

console.log(result.output, result.bestPath.length, result.stats.prunedNodes);
`;

const TIME_TRAVEL_CODE = `
const timeTravel = new TimeTravel(cog);

const result = await cog.run(agent, { input: 'Restock the warehouse for Q3' });
const step2 = await timeTravel.checkpoint(result, 2, 'before-stock');

const fork = await timeTravel.forkWithMockedTool(agent, step2.id, 'check_stock', {
  iron: 0,
});

const diff = await timeTravel.compare(result.trace.traceId, fork.result.trace.traceId);
console.log(timeTravel.formatDiff(diff));
`;

const PROMPTS_CODE = `
const cog = new Cogitator({ prompts: { autoDeployWinner: true } });

await cog.prompts.deploy(writer, 'You write release notes. Lead with what changed.');

await cog.prompts.startABTest(writer, {
  name: 'shorter notes',
  treatment: 'You write release notes in at most five bullet points.',
  treatmentAllocation: 0.3,
});

const result = await cog.run(writer, { input, threadId });
result.prompt?.abTest?.variant;

await cog.prompts.rollbackTo(writer);
`;

const LOGIC_CODE = `
const ns = createNeuroSymbolic();

ns.loadLogicProgram(\`
  role(ann, admin). role(bob, support).
  grants(admin, refund). grants(support, read).
  can(User, Action) :- role(User, Role), grants(Role, Action).
\`);

ns.proveLogic('can(bob, refund)').data;
ns.getLogicSolutions('can(ann, Action)?');

const tools = createNeuroSymbolicTools({ instance: ns }).all;
`;

const SHIP_CODE = `
const deployer = new Deployer();

const plan = await deployer.plan({ projectDir: '.', target: 'fly' });
for (const check of plan.preflight.checks) console.log(check.passed, check.message);

const result = await deployer.deploy({
  projectDir: '.',
  target: 'fly',
  configOverrides: { region: 'fra', instances: 2, secrets: ['ANTHROPIC_API_KEY'] },
});

console.log(result.url, result.endpoints?.a2a);
`;

/** Group B of the feature explorer: isolation, safety, operations, reasoning and shipping. */
export async function featuresB(): Promise<ExplorerFeature[]> {
  const [sandbox, safety, trace, handoff, reasoning, timeTravel, prompts, logic, ship] =
    await Promise.all(
      [
        SANDBOX_CODE,
        SAFETY_CODE,
        TRACE_CODE,
        HANDOFF_CODE,
        REASONING_CODE,
        TIME_TRAVEL_CODE,
        PROMPTS_CODE,
        LOGIC_CODE,
        SHIP_CODE,
      ].map((code) => highlightCode(code))
    );

  return [
    {
      id: 'sandbox',
      pkg: '@cogitator-ai/sandbox · @cogitator-ai/wasm-tools',
      title: 'Sandboxed execution',
      summary:
        'Model-written code runs in a fresh Docker container with no network and capped memory, CPU and time, or as a WASM module with no Docker at all.',
      href: '/docs/deployment/sandbox',
      code: sandbox,
    },
    {
      id: 'safety',
      pkg: '@cogitator-ai/core',
      title: 'Safety',
      summary:
        'Personal data is masked before the provider sees it, injection attempts fail the run, and guardrails block or rewrite unsafe inputs, outputs and tool calls.',
      href: '/docs/advanced/security',
      code: safety,
    },
    {
      id: 'observability',
      pkg: '@cogitator-ai/core',
      title: 'Observability & cost',
      summary:
        'Every run is a trace of LLM and tool spans with tokens and cost, exported to OpenTelemetry or Langfuse; cost routing sends easy tasks to cheaper models.',
      href: '/docs/deployment/observability',
      code: trace,
    },
    {
      id: 'handoffs',
      pkg: '@cogitator-ai/core',
      title: 'Handoffs',
      summary:
        'A triage agent passes the whole conversation to a specialist, which carries on with its own instructions, tools and model.',
      href: '/docs/core/agents#handoffs',
      code: handoff,
    },
    {
      id: 'reasoning',
      pkg: '@cogitator-ai/core',
      title: 'Tree-of-Thought',
      summary:
        'Explore several approaches at once, score each branch, prune the weak ones and return the best path instead of the first idea.',
      href: '/docs/advanced/reasoning',
      code: reasoning,
    },
    {
      id: 'time-travel',
      pkg: '@cogitator-ai/core',
      title: 'Time travel',
      summary:
        'Checkpoint a finished run at any tool call, fork it with a different tool result or input, and diff the two timelines.',
      href: '/docs/advanced/time-travel',
      code: timeTravel,
    },
    {
      id: 'prompt-versions',
      pkg: '@cogitator-ai/core',
      title: 'Prompt versions & A/B',
      summary:
        'Deploy new instructions without a redeploy, split live traffic between versions, promote the winner and roll back in one call.',
      href: '/docs/advanced/prompt-versions',
      code: prompts,
    },
    {
      id: 'neuro-symbolic',
      pkg: '@cogitator-ai/neuro-symbolic',
      title: 'Neuro-symbolic',
      summary:
        'Give agents a Prolog engine, constraint solving and plan validation, so rules are proved rather than guessed.',
      href: '/docs/advanced/neuro-symbolic',
      code: logic,
    },
    {
      id: 'ship',
      pkg: '@cogitator-ai/cli · @cogitator-ai/deploy · create-cogitator-app',
      title: 'Ship it',
      summary:
        'Scaffold a project, then deploy to Docker or Fly.io with a generated Dockerfile, preflight checks and secrets passed through.',
      href: '/docs/deployment/deploy-package',
      code: ship,
    },
  ];
}
