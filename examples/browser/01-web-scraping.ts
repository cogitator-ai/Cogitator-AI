import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

async function main() {
  header('01 — Web Scraping with Browser Agent');

  const session = new BrowserSession({ headless: true });
  await session.start();

  section('1. Create scraping agent');
  const agent = new Agent({
    name: 'web-scraper',
    model: DEFAULT_MODEL,
    instructions: `You are a web scraping agent. Use browser tools to navigate websites
and extract structured information. Always start by navigating to the URL,
then use extraction tools to get the data.`,
    tools: browserTools(session, { modules: ['navigation', 'extraction'] }),
    temperature: 0.2,
    maxIterations: 10,
  });

  const cog = createCogitator();

  section('2. Scrape Hacker News top stories');
  const result = await cog.run(agent, {
    input:
      'Go to https://news.ycombinator.com and extract the top 5 stories with their titles, URLs, and scores.',
  });

  console.log('Output:', result.output);
  console.log('Tool calls:', result.toolCalls.map((tc) => tc.name).join(', '));

  section('3. Extract links from a page');
  const result2 = await cog.run(agent, {
    input: 'Navigate to https://example.com and extract all links on the page.',
  });

  console.log('Output:', result2.output);

  await session.close();
  await cog.close();
  console.log('\nDone.');
}

main();
