import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

async function main() {
  header('03 — Stealth Browser Agent');

  section('1. Launch stealth session');
  const session = new BrowserSession({
    headless: true,
    stealth: {
      humanLikeTyping: true,
      humanLikeMouse: true,
      fingerprintRandomization: true,
      blockWebDriver: true,
    },
    viewport: { width: 1920, height: 1080 },
  });
  await session.start();

  console.log('Stealth enabled:', session.stealthEnabled);
  console.log('Stealth config:', JSON.stringify(session.stealthConfig, null, 2));

  section('2. Create stealth browsing agent');
  const agent = new Agent({
    name: 'stealth-browser',
    model: DEFAULT_MODEL,
    instructions: `You are a stealthy web browsing agent. Navigate websites naturally,
using human-like interactions. Take screenshots to observe page state
before and after actions.`,
    tools: browserTools(session),
    temperature: 0.3,
    maxIterations: 10,
  });

  const cog = createCogitator();

  section('3. Bot detection check');
  const result = await cog.run(agent, {
    input:
      'Go to https://bot.sannysoft.com and take a screenshot to check if bot detection is bypassed. Then extract the page text to summarize the detection results.',
  });

  console.log('Output:', result.output);
  console.log('Tool calls:', result.toolCalls.map((tc) => tc.name).join(', '));

  section('4. Stealth with boolean shorthand');
  const sessionSimple = new BrowserSession({
    headless: true,
    stealth: true,
  });
  await sessionSimple.start();
  console.log('Simple stealth enabled:', sessionSimple.stealthEnabled);
  console.log('Default config applied:', JSON.stringify(sessionSimple.stealthConfig, null, 2));
  await sessionSimple.close();

  await session.close();
  await cog.close();
  console.log('\nDone.');
}

main();
