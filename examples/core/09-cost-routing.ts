import { header, section } from '../_shared/setup.js';
import { CostAwareRouter } from '@cogitator-ai/core';

async function main() {
  header('09 — Cost-Aware Routing');

  section('1. Task analysis — complexity scoring');

  const router = new CostAwareRouter({
    config: {
      enabled: true,
      preferLocal: true,
      trackCosts: true,
    },
  });

  const tasks = [
    'What is 2 + 2?',
    'Summarize the key points of this article about climate change',
    'Analyze this image and describe what you see in the screenshot',
    'Search the database for all users who signed up last month, then calculate retention rate',
    'Design a comprehensive microservices architecture for a fintech platform. First, evaluate current constraints, then propose a solution with trade-offs analysis. If latency is critical, optimize for speed; otherwise, prioritize cost.',
    'Write a quick Python function to reverse a string',
    'Provide a detailed, thorough analysis of the codebase and refactor the authentication module',
  ];

  for (const task of tasks) {
    const requirements = router.analyzeTask(task);
    const label = task.length > 70 ? task.slice(0, 67) + '...' : task;
    console.log(`  Task: "${label}"`);
    console.log(`    Complexity:   ${requirements.complexity}`);
    console.log(`    Reasoning:    ${requirements.needsReasoning}`);
    console.log(`    Speed:        ${requirements.needsSpeed}`);
    console.log(`    Cost sens.:   ${requirements.costSensitivity}`);
    console.log(`    Vision:       ${requirements.needsVision}`);
    console.log(`    Tool calling: ${requirements.needsToolCalling}`);
    console.log(`    Long context: ${requirements.needsLongContext}`);
    console.log(`    Domains:      ${requirements.domains?.join(', ') || 'general'}`);
    console.log();
  }

  section('2. Model recommendations');

  const scenarios = [
    'What is the capital of France?',
    'Analyze this screenshot and find UI bugs',
    'Search the web for latest TypeScript release notes and summarize them',
    'Design and architect a distributed consensus algorithm with formal proof of correctness',
    'Write a budget-friendly, cheap summary of this text',
  ];

  for (const scenario of scenarios) {
    const rec = await router.recommendModel(scenario);
    const label = scenario.length > 60 ? scenario.slice(0, 57) + '...' : scenario;
    console.log(`  Task: "${label}"`);
    console.log(`    Model:    ${rec.modelId} (${rec.provider})`);
    console.log(`    Score:    ${rec.score}`);
    console.log(`    Est cost: $${rec.estimatedCost.toFixed(6)}`);
    console.log(`    Reasons:  ${rec.reasons.join('; ')}`);
    console.log(`    Fallback: ${rec.fallbacks.slice(0, 2).join(', ')}`);
    console.log();
  }

  section('3. Budget configuration and checking');

  const budgetRouter = new CostAwareRouter({
    config: {
      enabled: true,
      trackCosts: true,
      budget: {
        maxCostPerRun: 0.05,
        maxCostPerHour: 1.0,
        maxCostPerDay: 10.0,
        warningThreshold: 0.8,
        onBudgetWarning: (current, limit) => {
          console.log(`  [WARNING] Budget warning: $${current.toFixed(4)} / $${limit.toFixed(2)}`);
        },
        onBudgetExceeded: (current, limit) => {
          console.log(
            `  [EXCEEDED] Budget exceeded: $${current.toFixed(4)} > $${limit.toFixed(2)}`
          );
        },
      },
    },
  });

  const checks = [
    { cost: 0.01, label: 'small request' },
    { cost: 0.04, label: 'medium request' },
    { cost: 0.06, label: 'expensive request' },
  ];

  for (const { cost, label } of checks) {
    const result = budgetRouter.checkBudget(cost);
    console.log(
      `  Check $${cost.toFixed(2)} (${label}): ${result.allowed ? 'ALLOWED' : 'BLOCKED'}`
    );
    if (result.reason) console.log(`    Reason: ${result.reason}`);
  }

  section('4. Cost tracking');

  const runs = [
    {
      model: 'gemini-2.5-flash',
      agentId: 'summarizer',
      inputTokens: 1200,
      outputTokens: 400,
      cost: 0.002,
      runId: 'run-1',
    },
    {
      model: 'gemini-2.5-flash',
      agentId: 'summarizer',
      inputTokens: 800,
      outputTokens: 200,
      cost: 0.001,
      runId: 'run-2',
    },
    {
      model: 'gpt-4o',
      agentId: 'analyst',
      inputTokens: 5000,
      outputTokens: 2000,
      cost: 0.035,
      runId: 'run-3',
    },
    {
      model: 'claude-sonnet-4-5',
      agentId: 'coder',
      inputTokens: 3000,
      outputTokens: 1500,
      cost: 0.025,
      runId: 'run-4',
    },
    {
      model: 'gemini-2.5-flash',
      agentId: 'summarizer',
      inputTokens: 600,
      outputTokens: 150,
      cost: 0.0008,
      runId: 'run-5',
    },
  ];

  for (const run of runs) {
    budgetRouter.recordCost(run);
    console.log(`  Recorded: ${run.model} (${run.agentId}) — $${run.cost.toFixed(4)}`);
  }

  section('5. Cost summary');

  const summary = budgetRouter.getCostSummary();
  console.log(`  Total cost:     $${summary.totalCost.toFixed(4)}`);
  console.log(`  Total runs:     ${summary.runCount}`);
  console.log(`  Input tokens:   ${summary.totalInputTokens.toLocaleString()}`);
  console.log(`  Output tokens:  ${summary.totalOutputTokens.toLocaleString()}`);
  console.log(`  By model:`);
  for (const [model, cost] of Object.entries(summary.byModel)) {
    console.log(`    ${model}: $${cost.toFixed(4)}`);
  }
  console.log(`  By agent:`);
  for (const [agent, cost] of Object.entries(summary.byAgent)) {
    console.log(`    ${agent}: $${cost.toFixed(4)}`);
  }

  section('6. Budget status');

  const status = budgetRouter.getBudgetStatus();
  if (status) {
    console.log(
      `  Hourly: $${status.hourlyUsed.toFixed(4)} / $${status.hourlyLimit?.toFixed(2) ?? '∞'}`
    );
    console.log(
      `  Daily:  $${status.dailyUsed.toFixed(4)} / $${status.dailyLimit?.toFixed(2) ?? '∞'}`
    );
    if (status.hourlyRemaining !== undefined) {
      console.log(`  Hourly remaining: $${status.hourlyRemaining.toFixed(4)}`);
    }
    if (status.dailyRemaining !== undefined) {
      console.log(`  Daily remaining:  $${status.dailyRemaining.toFixed(4)}`);
    }
  }

  section('7. Dynamic config update');

  budgetRouter.updateConfig({
    budget: {
      maxCostPerRun: 0.1,
      maxCostPerHour: 2.0,
      maxCostPerDay: 20.0,
    },
  });

  const afterUpdate = budgetRouter.checkBudget(0.08);
  console.log(
    `  After raising limits, $0.08 request: ${afterUpdate.allowed ? 'ALLOWED' : 'BLOCKED'}`
  );

  console.log('\nDone.');
}

main();
