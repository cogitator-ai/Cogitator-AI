/**
 * Research Agent Example
 *
 * This example demonstrates an agent that can search the web
 * and synthesize information from multiple sources.
 */

import { Cogitator, Agent, tool } from '@cogitator/core';
import { z } from 'zod';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
  memory: {
    redis: { url: 'redis://localhost:6379' },
    postgres: { connectionString: process.env.DATABASE_URL! },
  },
});

// Web search tool (mock implementation)
const searchWeb = tool({
  name: 'search_web',
  description: 'Search the internet for information on a topic',
  parameters: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().default(5).describe('Number of results to return'),
  }),
  execute: async ({ query, limit }) => {
    // In production, integrate with a real search API (Serper, Tavily, etc.)
    console.log(`[Tool] Searching for: "${query}"`);

    // Mock results
    return [
      {
        title: `Result 1 for ${query}`,
        url: `https://example.com/1`,
        snippet: `This is a snippet about ${query}...`,
      },
      {
        title: `Result 2 for ${query}`,
        url: `https://example.com/2`,
        snippet: `More information about ${query}...`,
      },
    ].slice(0, limit);
  },
});

// URL reader tool (mock implementation)
const readUrl = tool({
  name: 'read_url',
  description: 'Read and extract the main content from a URL',
  parameters: z.object({
    url: z.string().url().describe('The URL to read'),
  }),
  execute: async ({ url }) => {
    // In production, use a proper web scraper
    console.log(`[Tool] Reading: ${url}`);

    return {
      url,
      title: 'Example Article',
      content: `This is the main content extracted from ${url}. It contains detailed information about the topic...`,
      wordCount: 500,
    };
  },
});

// Create the research agent
const researcher = new Agent({
  name: 'researcher',
  model: 'gpt-4o',
  instructions: `You are a thorough research assistant. When asked to research a topic:

    1. First, search the web for relevant information
    2. Read the most promising URLs to get detailed information
    3. Synthesize the information into a comprehensive answer
    4. Always cite your sources with URLs

    Be thorough but concise. Focus on accurate, up-to-date information.`,
  tools: [searchWeb, readUrl],
  temperature: 0.3,
  memory: {
    shortTerm: 'redis',
    longTerm: 'postgres',
    semantic: 'pgvector',
  },
});

async function main() {
  console.log('Starting research agent example...\n');

  // Research a topic
  const result = await cog.run(researcher, {
    input: 'Research the latest developments in WebGPU and how it compares to WebGL.',
    threadId: 'research-session-1',
  });

  console.log('Research Results:');
  console.log('=================\n');
  console.log(result.output);
  console.log('\n');

  console.log('Statistics:');
  console.log('-----------');
  console.log(`Total tokens: ${result.usage.totalTokens}`);
  console.log(`Cost: $${result.usage.cost.toFixed(4)}`);
  console.log(`Duration: ${result.usage.duration}ms`);
  console.log(`Tool calls: ${result.toolCalls.length}`);
  result.toolCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. ${call.name}(${JSON.stringify(call.arguments)})`);
  });

  // Follow-up question (uses memory from previous conversation)
  console.log('\n\nFollow-up question:');
  console.log('-------------------\n');

  const followUp = await cog.run(researcher, {
    input: 'Based on your research, what are the main advantages of WebGPU?',
    threadId: 'research-session-1', // Same thread to maintain context
  });

  console.log(followUp.output);

  await cog.close();
}

main().catch(console.error);
