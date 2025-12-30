/**
 * Local Swarm Example - Works with Ollama!
 *
 * A team of AI agents working together:
 * - Project Manager (supervisor) - coordinates tasks
 * - Researcher - gathers information
 * - Writer - creates content
 * - Critic - reviews and improves
 *
 * Run with: npx tsx examples/swarm-local.ts
 */

import { Cogitator, Agent, tool } from '@cogitator/core';
import { Swarm } from '@cogitator/swarms';
import { z } from 'zod';

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

const searchTool = tool({
  name: 'search',
  description: 'Search for information on a topic',
  parameters: z.object({
    query: z.string().describe('Search query'),
  }),
  execute: async ({ query }) => {
    console.log(`  📚 [Research] Searching: "${query}"`);
    await sleep(500);
    return {
      results: [
        `Key fact about ${query}: It's an important topic with many aspects.`,
        `Related to ${query}: There are multiple perspectives to consider.`,
        `Recent development in ${query}: New approaches are emerging.`,
      ],
    };
  },
});

const writeTool = tool({
  name: 'write_draft',
  description: 'Write a draft document',
  parameters: z.object({
    title: z.string(),
    content: z.string(),
    format: z.enum(['article', 'summary', 'report']).default('article'),
  }),
  execute: async ({ title, content, format }) => {
    console.log(`  ✍️  [Writer] Creating ${format}: "${title}"`);
    await sleep(300);
    return {
      documentId: `doc_${Date.now()}`,
      title,
      format,
      wordCount: content.split(' ').length,
      created: true,
    };
  },
});

const reviewTool = tool({
  name: 'review',
  description: 'Review and critique content',
  parameters: z.object({
    content: z.string(),
    criteria: z.array(z.string()).default(['clarity', 'accuracy', 'completeness']),
  }),
  execute: async ({ content, criteria }) => {
    console.log(`  🔍 [Critic] Reviewing against: ${criteria.join(', ')}`);
    await sleep(400);
    return {
      score: Math.floor(Math.random() * 3) + 7,
      feedback: [
        'Good structure overall',
        'Could add more specific examples',
        'Consider expanding the conclusion',
      ],
      approved: true,
    };
  },
});

const projectManager = new Agent({
  name: 'project-manager',
  model: MODEL,
  instructions: `You are a Project Manager coordinating a content creation team.

Your team:
- researcher: Gathers information and facts
- writer: Creates written content
- critic: Reviews and improves quality

For any task:
1. First, have the researcher gather relevant information
2. Then, have the writer create content based on research
3. Finally, have the critic review the work
4. Coordinate iterations if needed

Be concise and direct in your coordination.`,
  temperature: 0.3,
});

const researcher = new Agent({
  name: 'researcher',
  model: MODEL,
  instructions: `You are a Researcher. Your job is to:
- Search for relevant information on topics
- Summarize key findings
- Identify important facts and data

Use the search tool to find information. Be thorough but concise.`,
  tools: [searchTool],
  temperature: 0.2,
});

const writer = new Agent({
  name: 'writer',
  model: MODEL,
  instructions: `You are a Writer. Your job is to:
- Create clear, engaging content
- Use information provided by the researcher
- Structure content logically

Use the write_draft tool to save your work. Focus on clarity and readability.`,
  tools: [writeTool],
  temperature: 0.5,
});

const critic = new Agent({
  name: 'critic',
  model: MODEL,
  instructions: `You are a Critic. Your job is to:
- Review content for quality
- Identify areas for improvement
- Provide constructive feedback

Use the review tool to evaluate content. Be fair but thorough.`,
  tools: [reviewTool],
  temperature: 0.2,
});

const contentTeam = new Swarm({
  name: 'content-team',
  strategy: 'hierarchical',

  supervisor: projectManager,
  workers: [researcher, writer, critic],

  coordination: {
    visibility: 'full',
    workerCommunication: false,
    maxParallelTasks: 1,
  },

  resources: {
    maxConcurrency: 2,
    tokenBudget: 10_000,
    timeout: 120_000,
  },

  observability: {
    tracing: true,
    messageLogging: true,
  },
});

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║             🐝 Cogitator Swarm Example                       ║');
  console.log('║                                                              ║');
  console.log('║  A team of AI agents collaborating on a task                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Team Members:');
  console.log('  👔 project-manager (supervisor)');
  console.log('  🔬 researcher');
  console.log('  ✍️  writer');
  console.log('  🔍 critic');
  console.log('\n');

  const task = `Create a short article about the benefits of AI agents in software development.
The article should:
- Be informative but concise (200-300 words)
- Include at least 3 key benefits
- Have a clear introduction and conclusion`;

  console.log('📋 Task:');
  console.log('─'.repeat(60));
  console.log(task);
  console.log('─'.repeat(60));
  console.log('\n⏳ Working...\n');

  try {
    const result = await cog.run(contentTeam, { input: task });

    console.log('\n' + '═'.repeat(60));
    console.log('📄 Result:');
    console.log('═'.repeat(60));
    console.log(result.output);
    console.log('═'.repeat(60));

    console.log('\n📊 Execution Summary:');
    console.log(`   Total tokens: ${result.usage.totalTokens}`);
    console.log(`   Duration: ${(result.usage.duration / 1000).toFixed(1)}s`);
    console.log(`   Cost: $${result.usage.cost.toFixed(4)}`);

    if (result.trace?.spans) {
      console.log('\n🔍 Agent Activity:');
      result.trace.spans
        .filter((s) => s.name.startsWith('agent.'))
        .forEach((span) => {
          const agent = span.attributes?.agentName || span.name;
          console.log(`   ${agent}: ${span.duration}ms`);
        });
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
  }

  await cog.close();
  console.log('\n✅ Done!\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);

