import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig } from '@cogitator-ai/swarms';

async function main() {
  header('03 — Hierarchical Swarm');

  const cog = createCogitator();

  const frontendWorker = new Agent({
    name: 'frontend-specialist',
    model: DEFAULT_MODEL,
    instructions: `You are a frontend specialist. When given a task, provide a concrete implementation plan
with specific technologies, component structure, and code patterns. Be practical and specific.`,
    temperature: 0.5,
    maxIterations: 3,
  });

  const backendWorker = new Agent({
    name: 'backend-specialist',
    model: DEFAULT_MODEL,
    instructions: `You are a backend specialist. When given a task, provide a concrete implementation plan
with API design, database schema, and service architecture. Be practical and specific.`,
    temperature: 0.5,
    maxIterations: 3,
  });

  const devopsWorker = new Agent({
    name: 'devops-specialist',
    model: DEFAULT_MODEL,
    instructions: `You are a DevOps specialist. When given a task, provide a concrete deployment and infrastructure plan
with CI/CD, containerization, and monitoring. Be practical and specific.`,
    temperature: 0.5,
    maxIterations: 3,
  });

  const supervisor = new Agent({
    name: 'project-manager',
    model: DEFAULT_MODEL,
    instructions: `You are a senior project manager coordinating a team of specialists.
Analyze the incoming task and delegate specific subtasks to your workers using the delegate_task tool.
You MUST delegate to at least 2 workers before producing your final answer.
After all delegations complete, synthesize worker outputs into a unified project plan.`,
    temperature: 0.3,
    maxIterations: 10,
  });

  const config: SwarmConfig = {
    name: 'Project Planning',
    strategy: 'hierarchical',
    supervisor,
    workers: [frontendWorker, backendWorker, devopsWorker],
    hierarchical: {
      maxDelegationDepth: 2,
      workerCommunication: false,
      visibility: 'full',
    },
  };

  const swarm = new Swarm(cog, config);

  section('Event listeners');

  swarm.on('agent:start', (event) => {
    console.log(`  [agent:start] ${event.agentName}`);
  });

  swarm.on('agent:complete', (event) => {
    console.log(`  [agent:complete] ${event.agentName}`);
  });

  section('Running: plan a real-time analytics dashboard');

  const result = await swarm.run({
    input: `Plan a real-time analytics dashboard with WebSocket updates and role-based access.
Delegate the frontend part to the frontend-specialist and the backend part to the backend-specialist.
Then synthesize their responses into a short unified plan.`,
    saveHistory: false,
    timeout: 180_000,
  });

  section('Blackboard state');

  for (const sectionName of swarm.blackboard.getSections()) {
    const entry = swarm.blackboard.getSection(sectionName);
    if (entry) {
      const preview =
        typeof entry.data === 'string'
          ? entry.data.slice(0, 120)
          : JSON.stringify(entry.data).slice(0, 120);
      console.log(`  [${sectionName}] v${entry.version} by ${entry.modifiedBy}`);
      console.log(`    ${preview}...`);
    }
  }

  section('Supervisor output');

  const output = String(result.output);
  const lines = output.split('\n');
  for (const line of lines.slice(0, 35)) {
    console.log(`  ${line}`);
  }
  if (lines.length > 35) {
    console.log(`  ... (${lines.length - 35} more lines)`);
  }

  section('Agent results');

  for (const [name, agentResult] of result.agentResults) {
    const preview = agentResult.output.split('\n')[0].slice(0, 80);
    console.log(`  ${name}: ${agentResult.usage.totalTokens} tokens — "${preview}..."`);
  }

  section('Resource usage');

  const usage = swarm.getResourceUsage();
  console.log(`  Total tokens: ${usage.totalTokens}`);
  console.log(`  Total cost:   $${usage.totalCost.toFixed(4)}`);
  console.log(`  Elapsed time: ${usage.elapsedTime}ms`);

  for (const [agentName, agentUsage] of usage.agentUsage) {
    console.log(`  ${agentName}: ${agentUsage.tokens} tokens, ${agentUsage.runs} runs`);
  }

  await cog.close();
  console.log('\nDone.');
}

main();
