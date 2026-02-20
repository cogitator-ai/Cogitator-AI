import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig } from '@cogitator-ai/types';

async function main() {
  header('01 — Debate Swarm');

  const cog = createCogitator();

  const proOpenSource = new Agent({
    name: 'pro-open-source',
    model: DEFAULT_MODEL,
    instructions: `You are a passionate open-source advocate and software engineer.
You believe AI code should be open-source for transparency, community innovation, and democratic access.
Argue persuasively using concrete examples from the open-source ecosystem (Linux, TensorFlow, etc).
Keep your arguments focused — 2-3 key points per round.`,
    temperature: 0.7,
    maxIterations: 1,
  });

  const proClosedSource = new Agent({
    name: 'pro-closed-source',
    model: DEFAULT_MODEL,
    instructions: `You are a pragmatic AI startup CEO.
You believe AI code should be proprietary to protect intellectual property, fund research, and ensure safety.
Argue persuasively using business realities and safety concerns.
Keep your arguments focused — 2-3 key points per round.`,
    temperature: 0.7,
    maxIterations: 1,
  });

  const moderator = new Agent({
    name: 'moderator',
    model: DEFAULT_MODEL,
    instructions: `You are a neutral debate moderator and technology policy analyst.
Synthesize the arguments from both sides fairly. Identify the strongest points, areas of agreement,
and provide a balanced conclusion. Be analytical, not partisan.`,
    temperature: 0.4,
    maxIterations: 1,
  });

  const config: SwarmConfig = {
    name: 'AI Open Source Debate',
    strategy: 'debate',
    agents: [proOpenSource, proClosedSource],
    moderator,
    debate: {
      rounds: 2,
      format: 'structured',
    },
  };

  const debateSwarm = new Swarm(cog, config);

  section('Event listeners');

  debateSwarm.on('debate:round', (event) => {
    const { round, total } = event.data as { round: number; total: number };
    console.log(`\n  >> Round ${round}/${total}`);
  });

  debateSwarm.on('debate:turn', (event) => {
    const { agent, role } = event.data as { round: number; agent: string; role?: string };
    console.log(`  >> ${agent} (${role ?? 'debater'}) is speaking...`);
  });

  debateSwarm.on('agent:start', (event) => {
    const { agentName } = event.data as { agentName: string };
    console.log(`  [agent:start] ${agentName}`);
  });

  debateSwarm.on('agent:complete', (event) => {
    const { agentName } = event.data as { agentName: string };
    console.log(`  [agent:complete] ${agentName}`);
  });

  section('Running debate: "Should AI code be open-source?"');

  const result = await debateSwarm.run({
    input:
      'Should AI code be open-source? Consider safety, innovation, access, and business viability.',
    saveHistory: false,
  });

  section('Debate transcript');

  if (result.debateTranscript) {
    for (const msg of result.debateTranscript) {
      const role = (msg.metadata?.role as string) ?? msg.from;
      const round = msg.metadata?.round as number;
      console.log(`  [Round ${round}] ${msg.from} (${role}):`);
      const lines = msg.content.split('\n').slice(0, 8);
      for (const line of lines) {
        console.log(`    ${line}`);
      }
      if (msg.content.split('\n').length > 8) {
        console.log(`    ... (truncated)`);
      }
      console.log();
    }
  }

  section('Moderator synthesis');

  const output = String(result.output);
  const lines = output.split('\n');
  for (const line of lines.slice(0, 25)) {
    console.log(`  ${line}`);
  }
  if (lines.length > 25) {
    console.log(`  ... (${lines.length - 25} more lines)`);
  }

  section('Agent results');

  for (const [name, agentResult] of result.agentResults) {
    console.log(
      `  ${name}: ${agentResult.usage.totalTokens} tokens, ${agentResult.usage.duration}ms`
    );
  }

  section('Resource usage');

  const usage = debateSwarm.getResourceUsage();
  console.log(`  Total tokens: ${usage.totalTokens}`);
  console.log(`  Total cost:   $${usage.totalCost.toFixed(4)}`);
  console.log(`  Elapsed time: ${usage.elapsedTime}ms`);

  await cog.close();
  console.log('\nDone.');
}

main();
