/**
 * Local Workflow Example - Works with Ollama!
 *
 * A multi-step workflow demonstrating:
 * - Sequential steps with different agents
 * - Conditional branching
 * - Data passing between steps
 * - Error handling
 *
 * Run with: npx tsx examples/workflow-local.ts
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  functionNode,
  InMemoryCheckpointStore,
} from '@cogitator-ai/workflows';
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

const analyzeTool = tool({
  name: 'analyze_text',
  description: 'Analyze text for sentiment and key topics',
  parameters: z.object({
    text: z.string(),
  }),
  execute: async ({ text }) => {
    console.log('  📊 Analyzing text...');
    await sleep(300);
    
    const wordCount = text.split(/\s+/).length;
    const hasPositive = /good|great|excellent|happy|success/i.test(text);
    const hasNegative = /bad|poor|fail|sad|problem/i.test(text);
    
    return {
      wordCount,
      sentiment: hasPositive && !hasNegative ? 'positive' : hasNegative ? 'negative' : 'neutral',
      topics: ['technology', 'productivity', 'innovation'],
    };
  },
});

const generateTool = tool({
  name: 'generate_response',
  description: 'Generate a response based on analysis',
  parameters: z.object({
    topic: z.string(),
    tone: z.enum(['professional', 'casual', 'enthusiastic']),
  }),
  execute: async ({ topic, tone }) => {
    console.log(`  ✨ Generating ${tone} response about ${topic}...`);
    await sleep(200);
    return {
      generated: true,
      tone,
      topic,
    };
  },
});

const analyzer = new Agent({
  name: 'analyzer',
  model: MODEL,
  instructions: `You are a Text Analyzer. Analyze the given text and provide insights about:
- Main topics and themes
- Sentiment (positive, negative, neutral)
- Key points

Use the analyze_text tool and summarize findings concisely.`,
  tools: [analyzeTool],
  temperature: 0.1,
});

const strategist = new Agent({
  name: 'strategist',
  model: MODEL,
  instructions: `You are a Content Strategist. Based on the analysis provided:
- Determine the best response approach
- Suggest key points to address
- Recommend tone and style

Be strategic and concise.`,
  temperature: 0.3,
});

const responder = new Agent({
  name: 'responder',
  model: MODEL,
  instructions: `You are a Response Writer. Create a response that:
- Addresses the key points from the strategy
- Matches the recommended tone
- Is clear and engaging

Use the generate_response tool to structure your response.`,
  tools: [generateTool],
  temperature: 0.5,
});

const reviewer = new Agent({
  name: 'reviewer',
  model: MODEL,
  instructions: `You are a Quality Reviewer. Review the response for:
- Accuracy and relevance
- Tone appropriateness
- Completeness

Provide a brief quality assessment and approval status (approved/needs_revision).`,
  temperature: 0.2,
});

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║             📊 Cogitator Workflow Example                    ║');
  console.log('║                                                              ║');
  console.log('║  Multi-step processing with different AI agents             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const workflow = new WorkflowBuilder('content-response-workflow')
    .addNode(
      'analyze',
      agentNode({
        cogitator: cog,
        agent: analyzer,
        prompt: (ctx) => `Analyze this text: "${ctx.input.text}"`,
      })
    )
    .addNode(
      'strategize',
      agentNode({
        cogitator: cog,
        agent: strategist,
        prompt: (ctx) => `
          Based on this analysis:
          ${ctx.results.analyze}
          
          What's the best approach to respond?`,
      })
    )
    .addNode(
      'check_complexity',
      functionNode(async (ctx) => {
        const wordCount = ctx.input.text.split(/\s+/).length;
        return {
          needsDetailedResponse: wordCount > 50,
          complexity: wordCount > 50 ? 'high' : 'low',
        };
      })
    )
    .addNode(
      'respond',
      agentNode({
        cogitator: cog,
        agent: responder,
        prompt: (ctx) => `
          Create a response based on this strategy:
          ${ctx.results.strategize}
          
          Complexity level: ${ctx.results.check_complexity.complexity}`,
      })
    )
    .addNode(
      'review',
      agentNode({
        cogitator: cog,
        agent: reviewer,
        prompt: (ctx) => `
          Review this response:
          ${ctx.results.respond}
          
          Original text was: "${ctx.input.text}"`,
      })
    )
    .addEdge('analyze', 'strategize')
    .addEdge('strategize', 'check_complexity')
    .addEdge('check_complexity', 'respond')
    .addEdge('respond', 'review')
    .build();

  const executor = new WorkflowExecutor(workflow, {
    checkpointStore: new InMemoryCheckpointStore(),
  });

  console.log('Workflow Steps:');
  console.log('  1️⃣  analyze - Analyze the input text');
  console.log('  2️⃣  strategize - Determine response strategy');
  console.log('  3️⃣  check_complexity - Assess complexity');
  console.log('  4️⃣  respond - Generate response');
  console.log('  5️⃣  review - Quality check');
  console.log('\n');

  const input = {
    text: `We're excited to announce our new AI-powered productivity suite!
After months of development, our team has created tools that help
developers write better code faster. Key features include intelligent
code completion, automated testing, and real-time collaboration.
Early users report 40% improvement in development speed.`,
  };

  console.log('📥 Input:');
  console.log('─'.repeat(60));
  console.log(input.text);
  console.log('─'.repeat(60));
  console.log('\n⏳ Processing workflow...\n');

  try {
    const startTime = Date.now();
    let currentStep = '';

    const result = await executor.execute(input, {
      onNodeStart: (nodeId) => {
        currentStep = nodeId;
        console.log(`  ▶️  Starting: ${nodeId}`);
      },
      onNodeComplete: (nodeId, result) => {
        console.log(`  ✅ Completed: ${nodeId}`);
      },
      onNodeError: (nodeId, error) => {
        console.log(`  ❌ Error in ${nodeId}: ${error.message}`);
      },
    });

    const duration = Date.now() - startTime;

    console.log('\n' + '═'.repeat(60));
    console.log('📤 Workflow Results:');
    console.log('═'.repeat(60));

    for (const [step, output] of Object.entries(result.results)) {
      console.log(`\n📌 ${step}:`);
      console.log('─'.repeat(40));
      if (typeof output === 'string') {
        console.log(output.slice(0, 500) + (output.length > 500 ? '...' : ''));
      } else {
        console.log(JSON.stringify(output, null, 2).slice(0, 500));
      }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('📊 Execution Summary:');
    console.log(`   Status: ${result.status}`);
    console.log(`   Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log(`   Steps completed: ${Object.keys(result.results).length}`);

  } catch (error) {
    console.error('\n❌ Workflow Error:', error);
  }

  await cog.close();
  console.log('\n✅ Done!\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(console.error);

