import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { A2AServer } from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import { Agent } from '@cogitator-ai/core';
import express from 'express';

const PORT = 3100;

const agent = new Agent({
  name: 'writing-assistant',
  description:
    'A helpful writing assistant that can improve text, suggest edits, and answer questions about writing.',
  model: DEFAULT_MODEL,
  instructions: `You are a professional writing assistant. You help users improve their text,
suggest better phrasing, fix grammar, and answer questions about writing style.
Keep responses concise and actionable.`,
  temperature: 0.5,
  maxIterations: 3,
});

const cogitator = createCogitator();

const a2aServer = new A2AServer({
  agents: { 'writing-assistant': agent },
  cogitator,
  cardUrl: `http://localhost:${PORT}`,
});

const app = express();
app.use(a2aExpress(a2aServer));

app.listen(PORT, () => {
  header('A2A Server');

  const card = a2aServer.getAgentCard();
  console.log('Agent Card:');
  console.log(JSON.stringify(card, null, 2));
  console.log(`\nListening on http://localhost:${PORT}`);
  console.log(`Agent card:  http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`RPC endpoint: http://localhost:${PORT}/a2a`);
});
