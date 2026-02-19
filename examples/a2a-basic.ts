/**
 * A2A Protocol — Basic Example
 *
 * Demonstrates two Cogitator agents communicating via A2A:
 * 1. A "researcher" agent is exposed via A2A server
 * 2. A "writer" agent uses the researcher as a remote tool via A2AClient
 *
 * Run: npx tsx examples/a2a-basic.ts
 * Requires: OPENAI_API_KEY or running Ollama
 */

import { Agent, Cogitator } from '@cogitator-ai/core';
import { A2AServer, A2AClient } from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import express from 'express';

async function main() {
  const cogitator = new Cogitator();

  const researcher = new Agent({
    name: 'researcher',
    description: 'Research agent that finds and summarizes information',
    model: process.env.MODEL ?? 'ollama/llama3.2',
    instructions:
      'You are a research assistant. When given a topic, provide a concise, factual summary.',
  });

  const a2aServer = new A2AServer({
    agents: { researcher },
    cogitator,
    cardUrl: 'http://localhost:3456',
  });

  const app = express();
  app.use(a2aExpress(a2aServer));

  const server = app.listen(3456, () => {
    console.log('A2A Server running on http://localhost:3456');
    console.log('Agent Card: http://localhost:3456/.well-known/agent.json');
  });

  const client = new A2AClient('http://localhost:3456');

  const card = await client.agentCard();
  console.log(`\nDiscovered agent: ${card.name}`);
  console.log(`Description: ${card.description}`);
  console.log(`Skills: ${card.skills.map((s) => s.name).join(', ')}`);

  const remoteResearcher = client.asToolFromCard(card, {
    name: 'remote_researcher',
    description: 'Ask the remote research agent for information',
  });

  const writer = new Agent({
    name: 'writer',
    model: process.env.MODEL ?? 'ollama/llama3.2',
    instructions: `You are a writer. Use the remote_researcher tool to gather information,
then write a brief paragraph about the topic.`,
    tools: [remoteResearcher],
  });

  console.log('\nRunning writer agent (will delegate to researcher via A2A)...\n');

  const result = await cogitator.run(writer, {
    input: 'Write a brief overview of quantum computing',
  });

  console.log('--- Writer Output ---');
  console.log(result.output);
  console.log('\n--- Stats ---');
  console.log(`Tool calls: ${result.toolCalls.length}`);
  console.log(`Tokens: ${result.usage.totalTokens}`);

  server.close();
  await cogitator.close();
}

main().catch(console.error);
