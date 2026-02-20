import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { SwarmCoordinator, HierarchicalStrategy } from '@cogitator-ai/swarms';
import type { SwarmConfig } from '@cogitator-ai/types';
import { z } from 'zod';

function createSimpleDelegationTools(coordinator: SwarmCoordinator, supervisorName: string) {
  const blackboard = coordinator.blackboard;

  const delegateTask = tool({
    name: 'delegate_task',
    description: 'Delegate a task to a worker agent and get their response',
    parameters: z.object({
      worker: z.string().describe('Name of the worker agent to delegate to'),
      task: z.string().describe('The task description to delegate'),
    }),
    execute: async ({ worker, task }) => {
      const workerAgent = coordinator.getAgent(worker);
      if (!workerAgent) {
        const available = coordinator.getAgentsByRole('worker').map((a) => a.agent.name);
        return {
          success: false,
          error: `Worker '${worker}' not found`,
          availableWorkers: available,
        };
      }

      const result = await coordinator.runAgent(worker, task, {
        delegatedBy: supervisorName,
      });

      const workerResults = blackboard.has('workerResults')
        ? blackboard.read<Record<string, string>>('workerResults')
        : {};
      workerResults[worker] = result.output;
      blackboard.write('workerResults', workerResults, supervisorName);

      return {
        success: true,
        worker,
        output: result.output,
        tokens: result.usage.totalTokens,
      };
    },
  });

  const listWorkers = tool({
    name: 'list_workers',
    description: 'List all available worker agents and their current state',
    parameters: z.object({}),
    execute: async () => {
      const workers = coordinator.getAgentsByRole('worker');
      return {
        count: workers.length,
        workers: workers.map((w) => ({
          name: w.agent.name,
          state: w.state,
          description: w.agent.config.instructions.slice(0, 150),
        })),
      };
    },
  });

  return { delegateTask, listWorkers };
}

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
    tools: [],
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

  const coordinator = new SwarmCoordinator(cog, config);

  const tools = createSimpleDelegationTools(coordinator, 'project-manager');
  supervisor.config.tools!.push(tools.delegateTask, tools.listWorkers);

  section('Event listeners');

  coordinator.events.on('agent:start', (event) => {
    const { agentName } = event.data as { agentName: string };
    console.log(`  [agent:start] ${agentName}`);
  });

  coordinator.events.on('agent:complete', (event) => {
    const { agentName } = event.data as { agentName: string };
    console.log(`  [agent:complete] ${agentName}`);
  });

  section('Running: plan a real-time dashboard project');

  const strategy = new HierarchicalStrategy(coordinator, config.hierarchical);

  const result = await strategy.execute({
    input: `Plan a real-time analytics dashboard with WebSocket updates and role-based access.
Delegate the frontend part to the frontend-specialist and the backend part to the backend-specialist.
Then synthesize their responses into a short unified plan.`,
    saveHistory: false,
    timeout: 180_000,
  });

  section('Blackboard state');

  for (const sectionName of coordinator.blackboard.getSections()) {
    const entry = coordinator.blackboard.getSection(sectionName);
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

  const usage = coordinator.getResourceUsage();
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
