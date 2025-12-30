/**
 * Debate Swarm Example - AI Agents debating a topic!
 *
 * This demonstrates the "debate" strategy where multiple agents
 * argue different positions and reach a consensus.
 *
 * Run with: npx tsx examples/debate-swarm.ts
 */

import { Cogitator, Agent } from '@cogitator/core';
import { Swarm, DebateStrategy } from '@cogitator/swarms';

const MODEL = process.env.MODEL || 'llama3.2:3b';

console.log(`\n🤖 Using model: ${MODEL}`);
console.log('   (Set MODEL env var to use a different one)\n');

const cog = new Cogitator({
  llm: {
    defaultProvider: 'ollama',
    providers: {
      ollama: {
        baseUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
      },
    },
  },
});

const optimist = new Agent({
  name: 'optimist',
  model: MODEL,
  instructions: `You are an OPTIMIST in a debate. You always:
- Focus on positive outcomes and possibilities
- Highlight opportunities and benefits
- Remain constructive even when acknowledging challenges
- Support innovation and progress

In debates, make compelling arguments for why the optimistic view is correct.
Be persuasive but respectful of other viewpoints.
Keep responses concise (2-3 paragraphs max).`,
  temperature: 0.6,
});

const skeptic = new Agent({
  name: 'skeptic',
  model: MODEL,
  instructions: `You are a SKEPTIC in a debate. You always:
- Question assumptions and claims
- Point out potential risks and downsides
- Demand evidence and reasoning
- Consider worst-case scenarios

In debates, provide thoughtful counterarguments and concerns.
Be critical but fair and open to good arguments.
Keep responses concise (2-3 paragraphs max).`,
  temperature: 0.6,
});

const pragmatist = new Agent({
  name: 'pragmatist',
  model: MODEL,
  instructions: `You are a PRAGMATIST in a debate. You always:
- Focus on practical implications
- Balance idealism with reality
- Consider implementation challenges
- Seek workable compromises

In debates, bridge different viewpoints and find common ground.
Be practical and solution-oriented.
Keep responses concise (2-3 paragraphs max).`,
  temperature: 0.5,
});

const moderator = new Agent({
  name: 'moderator',
  model: MODEL,
  instructions: `You are a debate MODERATOR. Your job is to:
- Facilitate fair discussion between debaters
- Identify the strongest arguments from each side
- Synthesize a balanced conclusion
- Highlight areas of agreement and disagreement

After hearing all sides, provide a summary that:
1. Lists key arguments from each perspective
2. Notes where debaters agreed
3. Presents a balanced final conclusion`,
  temperature: 0.3,
});

const debateSwarm = new Swarm({
  name: 'debate-team',
  strategy: 'debate',

  supervisor: moderator,
  workers: [optimist, skeptic, pragmatist],

  coordination: {
    visibility: 'full',
    workerCommunication: true,
    maxParallelTasks: 1,
  },

  resources: {
    maxConcurrency: 1,
    tokenBudget: 15_000,
    timeout: 180_000,
  },

  strategyConfig: {
    maxRounds: 2,
    requireConsensus: false,
    votingEnabled: false,
  },

  observability: {
    tracing: true,
    messageLogging: true,
  },
});

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║             🎭 Cogitator Debate Example                      ║');
  console.log('║                                                              ║');
  console.log('║  AI agents debating different perspectives                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Debaters:');
  console.log('  😊 optimist - Focuses on positive outcomes');
  console.log('  🤔 skeptic - Questions and challenges');
  console.log('  ⚖️  pragmatist - Seeks practical solutions');
  console.log('  🎯 moderator - Synthesizes conclusions');
  console.log('\n');

  const topic = `Should companies adopt AI agents for customer support?

Consider:
- Impact on customer experience
- Cost implications
- Job displacement concerns
- Quality and reliability
- Scalability benefits`;

  console.log('📋 Debate Topic:');
  console.log('─'.repeat(60));
  console.log(topic);
  console.log('─'.repeat(60));
  console.log('\n⏳ Debate in progress...\n');

  try {
    const result = await cog.run(debateSwarm, {
      input: `Debate the following topic. Each participant should present their perspective, 
then the moderator should synthesize the discussion.

Topic: ${topic}`,
    });

    console.log('\n' + '═'.repeat(60));
    console.log('📜 Debate Conclusion:');
    console.log('═'.repeat(60));
    console.log(result.output);
    console.log('═'.repeat(60));

    console.log('\n📊 Debate Summary:');
    console.log(`   Total tokens: ${result.usage.totalTokens}`);
    console.log(`   Duration: ${(result.usage.duration / 1000).toFixed(1)}s`);
    console.log(`   Cost: $${result.usage.cost.toFixed(4)}`);

    if (result.trace?.spans) {
      console.log('\n🎤 Speaker Activity:');
      const agentSpans = result.trace.spans.filter((s) =>
        s.name.startsWith('agent.')
      );
      for (const span of agentSpans) {
        const name = span.attributes?.agentName || span.name.replace('agent.', '');
        console.log(`   ${name}: ${span.duration}ms`);
      }
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
  }

  await cog.close();
  console.log('\n✅ Debate complete!\n');
}

main().catch(console.error);

