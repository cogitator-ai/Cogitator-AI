import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig } from '@cogitator-ai/types';

async function main() {
  header('02 — Pipeline Swarm');

  const cog = createCogitator();

  const researcher = new Agent({
    name: 'researcher',
    model: DEFAULT_MODEL,
    instructions: `You are a research analyst. Given a topic, produce a structured research brief with:
- 3-5 key facts or findings
- Relevant statistics or data points
- Notable expert opinions or studies
Be factual and cite specifics. Output plain text, not markdown.`,
    temperature: 0.5,
    maxIterations: 1,
  });

  const writer = new Agent({
    name: 'writer',
    model: DEFAULT_MODEL,
    instructions: `You are a professional content writer. Given research material, write a compelling short article (300-400 words).
Structure it with a hook, body paragraphs, and a conclusion.
Write in an engaging, accessible style suitable for a tech blog.
Output plain text, not markdown.`,
    temperature: 0.7,
    maxIterations: 1,
  });

  const editor = new Agent({
    name: 'editor',
    model: DEFAULT_MODEL,
    instructions: `You are a senior editor. Given a draft article, improve it:
- Fix grammar, clarity, and flow
- Tighten wordy sentences
- Ensure factual claims are well-supported
- Add a compelling title at the top
Return the polished final article. Output plain text, not markdown.`,
    temperature: 0.3,
    maxIterations: 1,
  });

  const config: SwarmConfig = {
    name: 'Content Pipeline',
    strategy: 'pipeline',
    pipeline: {
      stages: [
        { name: 'research', agent: researcher },
        { name: 'writing', agent: writer },
        { name: 'editing', agent: editor },
      ],
    },
  };

  const pipelineSwarm = new Swarm(cog, config);

  section('Event listeners');

  pipelineSwarm.on('pipeline:stage', (event) => {
    const { index, name, total } = event.data as { index: number; name: string; total: number };
    console.log(`\n  >> Stage ${index + 1}/${total}: ${name}`);
  });

  pipelineSwarm.on('pipeline:stage:complete', (event) => {
    const { name } = event.data as { name: string };
    console.log(`  >> Stage "${name}" complete`);
  });

  pipelineSwarm.on('agent:start', (event) => {
    const { agentName } = event.data as { agentName: string };
    console.log(`  [agent:start] ${agentName}`);
  });

  pipelineSwarm.on('agent:complete', (event) => {
    const { agentName } = event.data as { agentName: string };
    console.log(`  [agent:complete] ${agentName}`);
  });

  section('Running pipeline: article about edge computing');

  const result = await pipelineSwarm.run({
    input: 'Write an article about edge computing and why it matters for AI inference in 2026.',
    saveHistory: false,
  });

  section('Stage outputs');

  if (result.pipelineOutputs) {
    for (const [stageName, output] of result.pipelineOutputs) {
      console.log(`  === ${stageName.toUpperCase()} ===`);
      const text = String(output);
      const lines = text.split('\n').slice(0, 10);
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      if (text.split('\n').length > 10) {
        console.log(`  ... (${text.split('\n').length - 10} more lines)`);
      }
      console.log();
    }
  }

  section('Final article');

  const output = String(result.output);
  const lines = output.split('\n');
  for (const line of lines.slice(0, 30)) {
    console.log(`  ${line}`);
  }
  if (lines.length > 30) {
    console.log(`  ... (${lines.length - 30} more lines)`);
  }

  section('Token usage per stage');

  for (const [name, agentResult] of result.agentResults) {
    console.log(
      `  ${name}: ${agentResult.usage.totalTokens} tokens, ${agentResult.usage.duration}ms`
    );
  }

  section('Resource usage');

  const usage = pipelineSwarm.getResourceUsage();
  console.log(`  Total tokens: ${usage.totalTokens}`);
  console.log(`  Total cost:   $${usage.totalCost.toFixed(4)}`);
  console.log(`  Elapsed time: ${usage.elapsedTime}ms`);

  await cog.close();
  console.log('\nDone.');
}

main();
