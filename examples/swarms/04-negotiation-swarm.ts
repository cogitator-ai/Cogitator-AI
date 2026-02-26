import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig, NegotiationResult } from '@cogitator-ai/types';

async function main() {
  header('04 — Negotiation Swarm');

  const cog = createCogitator();

  const buyer = new Agent({
    name: 'buyer',
    model: DEFAULT_MODEL,
    instructions: `You are a buyer negotiating a software licensing deal.
Your budget is $50,000/year. You want the best price with maximum features.
Start by proposing $30,000/year for the full package.
Be willing to compromise on non-essential features to stay under budget.
Use structured terms: price, license_seats, support_tier, contract_length.`,
    temperature: 0.7,
    maxIterations: 1,
  });

  const seller = new Agent({
    name: 'seller',
    model: DEFAULT_MODEL,
    instructions: `You are a seller negotiating a software licensing deal.
Your minimum acceptable price is $40,000/year for the full package.
You can offer discounts for longer contracts or fewer seats.
Start by proposing $65,000/year for the premium package.
Use structured terms: price, license_seats, support_tier, contract_length.`,
    temperature: 0.7,
    maxIterations: 1,
  });

  const config: SwarmConfig = {
    name: 'License Negotiation',
    strategy: 'negotiation',
    agents: [buyer, seller],
    negotiation: {
      maxRounds: 6,
      turnOrder: 'round-robin',
      onDeadlock: 'arbitrate',
      stagnationThreshold: 0.05,
    },
  };

  const negotiationSwarm = new Swarm(cog, config);

  section('Event listeners');

  negotiationSwarm.on('negotiation:phase-change', (event) => {
    const { phase } = event.data as { phase: string };
    console.log(`\n  >> Phase: ${phase}`);
  });

  negotiationSwarm.on('negotiation:round', (event) => {
    const { round, maxRounds } = event.data as { round: number; maxRounds: number };
    console.log(`  >> Round ${round}/${maxRounds}`);
  });

  negotiationSwarm.on('negotiation:offer', (event) => {
    const { from, to } = event.data as { from: string; to: string };
    console.log(`  >> ${from} makes an offer to ${to}`);
  });

  negotiationSwarm.on('negotiation:convergence-update', (event) => {
    const { metrics } = event.data as { metrics: { overallConvergence: number } };
    console.log(`  >> Convergence: ${(metrics.overallConvergence * 100).toFixed(1)}%`);
  });

  negotiationSwarm.on('negotiation:agreement-reached', () => {
    console.log(`\n  >> Agreement reached!`);
  });

  negotiationSwarm.on('negotiation:terminated', () => {
    console.log(`\n  >> Negotiation terminated without agreement`);
  });

  section('Running negotiation: Software licensing deal');

  const result = await negotiationSwarm.run({
    input:
      'Negotiate a software licensing deal. Key terms: price per year, number of seats, support tier (basic/premium/enterprise), and contract length.',
    saveHistory: false,
  });

  section('Negotiation result');

  const negotiation = result.negotiationResult as NegotiationResult | undefined;
  if (negotiation) {
    console.log(`  Outcome:    ${negotiation.outcome}`);
    console.log(`  Rounds:     ${negotiation.rounds}`);
    console.log(`  Duration:   ${negotiation.duration}ms`);
    console.log(`  Offers:     ${negotiation.offers.length}`);

    if (negotiation.agreement) {
      console.log(`\n  Agreement terms:`);
      for (const term of negotiation.agreement.terms) {
        console.log(`    ${term.name}: ${JSON.stringify(term.value)} (${term.status})`);
      }
    }

    if (negotiation.finalPositions) {
      console.log(`\n  Final positions:`);
      for (const [agent, offer] of Object.entries(negotiation.finalPositions)) {
        if (offer) {
          console.log(`    ${agent}: ${offer.terms.length} terms proposed`);
        }
      }
    }
  }

  section('Final output');

  const output = String(result.output);
  const lines = output.split('\n');
  for (const line of lines.slice(0, 30)) {
    console.log(`  ${line}`);
  }
  if (lines.length > 30) {
    console.log(`  ... (${lines.length - 30} more lines)`);
  }

  section('Resource usage');

  const usage = negotiationSwarm.getResourceUsage();
  console.log(`  Total tokens: ${usage.totalTokens}`);
  console.log(`  Total cost:   $${usage.totalCost.toFixed(4)}`);
  console.log(`  Elapsed time: ${usage.elapsedTime}ms`);

  await cog.close();
  console.log('\nDone.');
}

main();
