import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

async function main() {
  header('02 — Form Automation with Browser Agent');

  const session = new BrowserSession({
    headless: true,
    viewport: { width: 1920, height: 1080 },
  });
  await session.start();

  section('1. Create form automation agent');
  const agent = new Agent({
    name: 'form-filler',
    model: DEFAULT_MODEL,
    instructions: `You are a form automation agent. Navigate to the given URL,
fill in the form fields with the provided data, and submit the form.
Use the fillForm tool for efficient form filling when possible.`,
    tools: browserTools(session, { modules: ['navigation', 'interaction', 'extraction'] }),
    temperature: 0.1,
    maxIterations: 15,
  });

  const cog = createCogitator();

  section('2. Fill and submit a form');
  const result = await cog.run(agent, {
    input: `Go to https://httpbin.org/forms/post and fill the form with:
    - Customer name: John Doe
    - Telephone: 555-1234
    - Email: john@example.com
    - Size: Medium
    Then submit the form.`,
  });

  console.log('Output:', result.output);
  console.log('Tool calls:', result.toolCalls.map((tc) => tc.name).join(', '));

  section('3. Read back submitted data');
  const result2 = await cog.run(agent, {
    input: 'Extract the text content from the current page to see the form submission result.',
  });

  console.log('Output:', result2.output);

  await session.close();
  await cog.close();
  console.log('\nDone.');
}

main();
