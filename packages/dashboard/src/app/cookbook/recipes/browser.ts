import type { Section } from './types';

export const browser: Section = {
  id: 'browser',
  title: 'Browser Agents',
  icon: '🌍',
  description:
    'Agents that drive a real browser: scraping, filling forms and browsing with stealth.',
  recipes: [
    {
      id: 'web-scraping',
      title: 'Web Scraping',
      difficulty: 'easy',
      time: '10 min',
      problem: 'You want structured data from a page that has no API.',
      points: [
        'Start a `BrowserSession`',
        'Give the agent the navigation and extraction modules of `browserTools()`',
      ],
      file: 'web-scraping.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const session = new BrowserSession({ headless: true });
await session.start();

const scraper = new Agent({
  name: 'web-scraper',
  model: 'google/gemini-3.5-flash-lite',
  instructions: \`You are a web scraping agent. Navigate to the URL first,
then use the extraction tools to collect structured data.\`,
  tools: browserTools(session, { modules: ['navigation', 'extraction'] }),
  temperature: 0.2,
  maxIterations: 10,
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

try {
  const result = await cog.run(scraper, {
    input: 'Go to https://news.ycombinator.com and extract the top 5 stories with titles, URLs and scores.',
  });
  console.log(result.output);
  console.log('Tools:', result.toolCalls.map((call) => call.name).join(', '));
} finally {
  await session.close();
  await cog.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/browser playwright',
      setup: 'npx playwright install chromium',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx web-scraping.ts',
      repoRun: 'npx tsx examples/browser/01-web-scraping.ts',
      example: 'browser/01-web-scraping.ts',
      docs: [
        {
          href: '/docs/browser',
          label: 'Browser',
        },
      ],
    },
    {
      id: 'form-automation',
      title: 'Form Automation',
      difficulty: 'medium',
      time: '10 min',
      problem: 'A form has to be filled and submitted on a site without an API.',
      points: ['Add the `interaction` module so the agent can type, select and submit'],
      file: 'form-automation.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const session = new BrowserSession({ headless: true, viewport: { width: 1920, height: 1080 } });
await session.start();

const formFiller = new Agent({
  name: 'form-filler',
  model: 'google/gemini-3.5-flash-lite',
  instructions: \`You are a form automation agent. Navigate to the URL, fill in the fields
with the provided data and submit the form. Prefer browser_fill_form for filling several fields at once.\`,
  tools: browserTools(session, { modules: ['navigation', 'interaction', 'extraction'] }),
  temperature: 0.1,
  maxIterations: 15,
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

try {
  const submitted = await cog.run(formFiller, {
    input: \`Go to https://httpbin.org/forms/post and fill the form with:
- Customer name: John Doe
- Telephone: 555-1234
- Email: john@example.com
- Size: Medium
Then submit the form.\`,
  });
  console.log(submitted.output);

  const echoed = await cog.run(formFiller, {
    input: 'Extract the text of the current page to show what the server received.',
  });
  console.log(echoed.output);
} finally {
  await session.close();
  await cog.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/browser playwright',
      setup: 'npx playwright install chromium',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx form-automation.ts',
      repoRun: 'npx tsx examples/browser/02-form-automation.ts',
      example: 'browser/02-form-automation.ts',
      docs: [
        {
          href: '/docs/browser/tools',
          label: 'Browser Tools',
        },
      ],
    },
    {
      id: 'stealth-browser',
      title: 'Stealth Browsing',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Some sites treat headless browsers differently. You want human-like typing and mouse movement and a less obvious fingerprint.',
      points: [
        'Configure `stealth` on `BrowserSession` (or pass `stealth: true` for the defaults)',
      ],
      file: 'stealth-browser.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { BrowserSession, browserTools } from '@cogitator-ai/browser';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

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
console.log('Stealth enabled:', session.stealthEnabled, session.stealthConfig);

const browser = new Agent({
  name: 'stealth-browser',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You browse websites with human-like interactions. Take screenshots to observe the page.',
  tools: browserTools(session),
  temperature: 0.3,
  maxIterations: 10,
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

try {
  const result = await cog.run(browser, {
    input: 'Go to https://bot.sannysoft.com, then extract the page text and summarize the bot-detection results.',
  });
  console.log(result.output);
} finally {
  await session.close();
  await cog.close();
}`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/browser playwright',
      setup: 'npx playwright install chromium',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx stealth-browser.ts',
      repoRun: 'npx tsx examples/browser/03-stealth-agent.ts',
      notes: [
        {
          type: 'warning',
          text: 'Respect each site’s terms of service and robots rules.',
        },
      ],
      example: 'browser/03-stealth-agent.ts',
      docs: [
        {
          href: '/docs/browser/stealth',
          label: 'Stealth',
        },
      ],
    },
  ],
};
