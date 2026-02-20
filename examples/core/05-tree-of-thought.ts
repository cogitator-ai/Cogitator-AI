import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, ThoughtTreeExecutor } from '@cogitator-ai/core';

async function main() {
  header('05 — Tree of Thought');

  const cog = createCogitator();

  const agent = new Agent({
    name: 'architect',
    model: DEFAULT_MODEL,
    instructions: `You are a senior software architect specializing in distributed systems.
When given a design problem, think through trade-offs carefully.
Consider scalability, latency, consistency, and operational complexity.
Be concrete — mention specific technologies, data structures, and protocols.`,
    temperature: 0.7,
    maxIterations: 5,
  });

  section('1. Configuring ThoughtTreeExecutor');

  const tot = new ThoughtTreeExecutor(cog, {
    maxDepth: 2,
    branchFactor: 2,
    beamWidth: 2,
    confidenceThreshold: 0.2,
    terminationConfidence: 0.85,
    maxTotalNodes: 12,
    timeout: 120_000,

    onBranchGenerated: (node, branches) => {
      console.log(`  [branch] depth=${node.depth} → ${branches.length} branches generated`);
      for (const b of branches) {
        const preview = b.thought.slice(0, 80).replace(/\n/g, ' ');
        console.log(`           "${preview}..."`);
      }
    },

    onBranchEvaluated: (branch, score) => {
      console.log(
        `  [eval]   "${branch.thought.slice(0, 50).replace(/\n/g, ' ')}..." → ` +
          `composite=${score.composite.toFixed(2)} confidence=${score.confidence.toFixed(2)}`
      );
    },

    onNodeExplored: (node) => {
      console.log(
        `  [node]   depth=${node.depth} cumScore=${node.cumulativeScore.toFixed(2)} ` +
          `status=${node.status}`
      );
    },
  });

  section('2. Exploring: caching strategy for a social media feed');

  const goal =
    'Design a caching strategy for a social media feed that handles 10M daily active users. ' +
    'The feed shows posts from followed users, ranked by relevance. ' +
    'Consider cache invalidation, personalization, and cold start for new users.';

  console.log(`  Goal: ${goal}\n`);

  const result = await tot.explore(agent, goal, {
    timeout: 120_000,
  });

  section('3. Results');

  console.log(`  Success:      ${result.success}`);
  console.log(`  Best score:   ${result.tree.bestScore.toFixed(2)}`);
  console.log(`  Total nodes:  ${result.stats.totalNodes}`);
  console.log(`  Explored:     ${result.stats.exploredNodes}`);
  console.log(`  Pruned:       ${result.stats.prunedNodes}`);
  console.log(`  Max depth:    ${result.stats.maxDepthReached}`);
  console.log(`  Backtracks:   ${result.stats.backtrackCount}`);
  console.log(`  LLM calls:    ${result.stats.llmCalls}`);
  console.log(`  Duration:     ${(result.stats.duration / 1000).toFixed(1)}s`);
  console.log(
    `  Tokens:       ${result.usage.totalTokens} (in=${result.usage.inputTokens} out=${result.usage.outputTokens})`
  );

  section('4. Best path through the tree');

  for (let i = 0; i < result.bestPath.length; i++) {
    const node = result.bestPath[i];
    const thought = node.branch.thought.slice(0, 100).replace(/\n/g, ' ');
    const score = node.branch.score?.composite?.toFixed(2) ?? 'n/a';
    console.log(`  [${i}] depth=${node.depth} score=${score}`);
    console.log(`      "${thought}..."`);
  }

  section('5. Final output');

  const lines = result.output.split('\n');
  for (const line of lines.slice(0, 30)) {
    console.log(`  ${line}`);
  }
  if (lines.length > 30) {
    console.log(`  ... (${lines.length - 30} more lines)`);
  }

  await cog.close();
  console.log('\nDone.');
}

main();
