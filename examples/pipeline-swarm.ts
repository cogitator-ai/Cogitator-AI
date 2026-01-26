/**
 * Pipeline Swarm Example - Assembly Line of AI Agents!
 *
 * This demonstrates the "pipeline" strategy where tasks flow
 * through agents sequentially, each adding their contribution.
 *
 * Perfect for content creation, data processing, code review, etc.
 *
 * Run with: npx tsx examples/pipeline-swarm.ts
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import { z } from 'zod';

const MODEL = process.env.MODEL || 'qwen2.5:7b';

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

const extractKeywords = tool({
  name: 'extract_keywords',
  description: 'Extract key concepts from text',
  parameters: z.object({
    text: z.string(),
    maxKeywords: z.number().default(5),
  }),
  execute: async ({ text, maxKeywords }) => {
    console.log('  🔑 Extracting keywords...');
    const words = text.toLowerCase().split(/\W+/);
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'as',
      'into',
      'through',
      'during',
      'before',
      'after',
      'above',
      'below',
      'between',
      'under',
      'again',
      'further',
      'then',
      'once',
      'and',
      'but',
      'or',
      'nor',
      'so',
      'yet',
      'both',
      'either',
      'neither',
      'not',
      'only',
      'own',
      'same',
      'than',
      'too',
      'very',
      'just',
      'also',
    ]);
    const filtered = words.filter((w) => w.length > 3 && !stopWords.has(w));
    const unique = [...new Set(filtered)].slice(0, maxKeywords);
    return { keywords: unique };
  },
});

const generateOutline = tool({
  name: 'generate_outline',
  description: 'Create a structured outline',
  parameters: z.object({
    topic: z.string(),
    sections: z.number().default(3),
  }),
  execute: async ({ topic, sections }) => {
    console.log(`  📝 Generating outline with ${sections} sections...`);
    return {
      topic,
      outline: [
        { title: 'Introduction', points: ['Context', 'Importance'] },
        { title: 'Main Discussion', points: ['Key aspects', 'Examples'] },
        { title: 'Conclusion', points: ['Summary', 'Next steps'] },
      ].slice(0, sections),
    };
  },
});

const formatOutput = tool({
  name: 'format_output',
  description: 'Format the final output nicely',
  parameters: z.object({
    content: z.string(),
    format: z.enum(['markdown', 'plain', 'html']).default('markdown'),
  }),
  execute: async ({ content, format }) => {
    console.log(`  🎨 Formatting as ${format}...`);
    return {
      formatted: true,
      format,
      length: content.length,
    };
  },
});

const ideaGenerator = new Agent({
  name: 'idea-generator',
  model: MODEL,
  instructions: `You are the IDEA GENERATOR - Stage 1 of the pipeline.

Your job:
1. Take the input topic/request
2. Brainstorm creative angles and approaches
3. Extract key themes using the extract_keywords tool
4. Pass a rich set of ideas to the next stage

Output format:
- Main concept
- 3-5 creative angles
- Key themes identified`,
  tools: [extractKeywords],
  temperature: 0.7,
});

const structurer = new Agent({
  name: 'structurer',
  model: MODEL,
  instructions: `You are the STRUCTURER - Stage 2 of the pipeline.

Your job:
1. Take ideas from the previous stage
2. Organize them into a logical structure
3. Create an outline using generate_outline tool
4. Define the flow of information

Output format:
- Clear outline with sections
- Logical progression
- Notes on what each section covers`,
  tools: [generateOutline],
  temperature: 0.3,
});

const contentCreator = new Agent({
  name: 'content-creator',
  model: MODEL,
  instructions: `You are the CONTENT CREATOR - Stage 3 of the pipeline.

Your job:
1. Take the structure from the previous stage
2. Fill in each section with actual content
3. Maintain consistent tone and style
4. Keep content concise but informative

Output format:
- Complete content following the outline
- Clear writing
- 200-400 words total`,
  temperature: 0.5,
});

const polisher = new Agent({
  name: 'polisher',
  model: MODEL,
  instructions: `You are the POLISHER - Stage 4 of the pipeline.

Your job:
1. Take the content from previous stage
2. Improve clarity and flow
3. Fix any issues
4. Format the final output using format_output tool

Output format:
- Polished final content
- Well-formatted
- Ready for publication`,
  tools: [formatOutput],
  temperature: 0.2,
});

const contentPipeline = new Swarm({
  name: 'content-pipeline',
  strategy: 'pipeline',

  workers: [ideaGenerator, structurer, contentCreator, polisher],

  coordination: {
    visibility: 'sequential',
    workerCommunication: false,
    maxParallelTasks: 1,
  },

  strategyConfig: {
    stages: [
      { name: 'ideation', agent: 'idea-generator' },
      { name: 'structuring', agent: 'structurer' },
      { name: 'creation', agent: 'content-creator' },
      { name: 'polishing', agent: 'polisher' },
    ],
    passFullContext: false,
    gating: { enabled: false },
  },

  resources: {
    maxConcurrency: 1,
    tokenBudget: 15_000,
    timeout: 180_000,
  },

  observability: {
    tracing: true,
    messageLogging: true,
  },
});

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║             🏭 Cogitator Pipeline Example                    ║');
  console.log('║                                                              ║');
  console.log('║  Assembly line of AI agents processing content               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('Pipeline Stages:');
  console.log('  1️⃣  idea-generator → Brainstorm ideas');
  console.log('  2️⃣  structurer → Organize structure');
  console.log('  3️⃣  content-creator → Write content');
  console.log('  4️⃣  polisher → Final polish');
  console.log('\n');

  const task = `Create a short blog post about "The Future of Remote Work"

Requirements:
- Engaging and informative
- Include current trends
- Make predictions for 2025
- Actionable advice for readers`;

  console.log('📥 Input:');
  console.log('─'.repeat(60));
  console.log(task);
  console.log('─'.repeat(60));
  console.log('\n⏳ Pipeline processing...\n');

  try {
    const result = await cog.run(contentPipeline, { input: task });

    console.log('\n' + '═'.repeat(60));
    console.log('📤 Pipeline Output:');
    console.log('═'.repeat(60));
    console.log(result.output);
    console.log('═'.repeat(60));

    console.log('\n📊 Pipeline Summary:');
    console.log(`   Total tokens: ${result.usage.totalTokens}`);
    console.log(`   Duration: ${(result.usage.duration / 1000).toFixed(1)}s`);
    console.log(`   Cost: $${result.usage.cost.toFixed(4)}`);

    if (result.trace?.spans) {
      console.log('\n⏱️  Stage Timings:');
      const stages = result.trace.spans.filter((s) => s.name.startsWith('agent.'));
      stages.forEach((span, i) => {
        const name = span.attributes?.agentName || `Stage ${i + 1}`;
        console.log(`   ${i + 1}. ${name}: ${span.duration}ms`);
      });
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
  }

  await cog.close();
  console.log('\n✅ Pipeline complete!\n');
}

main().catch(console.error);
