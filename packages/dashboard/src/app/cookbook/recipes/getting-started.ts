import type { Section } from './types';

export const gettingStarted: Section = {
  id: 'getting-started',
  title: 'Getting Started',
  icon: '🚀',
  description:
    'A first agent with tools and streaming, the built-in tools, typed JSON answers and a scaffolded project.',
  recipes: [
    {
      id: 'first-agent',
      title: 'Your First Agent',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You want an agent that answers questions with your own data: a tool with a Zod schema, a normal run, a streamed run and the token usage.',
      points: [
        'Define a tool with `tool()` and a Zod schema',
        'Run an agent with `cog.run()` and read `output` and `toolCalls`',
        'Stream tokens with `stream: true` and `onToken`',
      ],
      file: 'first-agent.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const dictionary: Record<string, string> = {
  petrichor: 'The pleasant earthy smell after rain.',
  sonder: 'The realization that each passerby has a life as vivid and complex as your own.',
};

const lookupWord = tool({
  name: 'lookup_word',
  description: 'Look up the definition of a word in the dictionary',
  parameters: z.object({
    word: z.string().describe('The word to look up'),
  }),
  execute: async ({ word }) => {
    const definition = dictionary[word.toLowerCase().trim()];
    return definition ? { found: true, word, definition } : { found: false, word };
  },
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const agent = new Agent({
  name: 'lexicon',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful language assistant. Use your tools to look up words. Be concise.',
  tools: [lookupWord],
  temperature: 0.3,
  maxIterations: 5,
});

const result = await cog.run(agent, { input: 'What does "petrichor" mean?' });
console.log(result.output);
console.log('Tool calls:', result.toolCalls.map((call) => call.name));

process.stdout.write('Streaming: ');
const streamed = await cog.run(agent, {
  input: 'What does "sonder" mean? Explain in one sentence.',
  stream: true,
  onToken: (token) => process.stdout.write(token),
});
console.log('\\nTokens:', streamed.usage.inputTokens, 'in /', streamed.usage.outputTokens, 'out');

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx first-agent.ts',
      repoRun: 'npx tsx examples/core/01-basic-agent.ts',
      example: 'core/01-basic-agent.ts',
      docs: [
        {
          href: '/docs/getting-started/quick-start',
          label: 'Quick Start',
        },
        {
          href: '/docs/tools/custom-tools',
          label: 'Custom Tools',
        },
      ],
    },
    {
      id: 'built-in-tools',
      title: 'Built-in Tools',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You need an analyst that reads files and does exact math instead of guessing, without writing the tools yourself.',
      points: [
        'Use `calculator`, `datetime`, `fileRead`, `fileList` and `regexMatch` from `@cogitator-ai/core`',
        'Let the agent chain several tool calls in one run',
      ],
      file: 'built-in-tools.ts',
      code: `import { Agent, Cogitator, calculator, datetime, fileList, fileRead, regexMatch } from '@cogitator-ai/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const dataDir = join(process.cwd(), 'sales-data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(dataDir, 'sales-q4.csv'),
  [
    'date,product,quantity,price',
    '2025-10-01,Widget A,150,29.99',
    '2025-11-01,Widget A,200,29.99',
    '2025-11-20,Widget C,45,99.99',
    '2025-12-18,Widget A,300,29.99',
  ].join('\\n')
);

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const analyst = new Agent({
  name: 'analyst',
  model: 'google/gemini-3.5-flash-lite',
  instructions: \`You are a data analyst with filesystem, calculator, datetime and regex tools.
Read files first, use the calculator for math and regex for pattern extraction.\`,
  tools: [calculator, datetime, fileRead, fileList, regexMatch],
  temperature: 0.2,
  maxIterations: 15,
});

const revenue = await cog.run(analyst, {
  input: \`Read \${join(dataDir, 'sales-q4.csv')} and calculate the total revenue for Widget A.\`,
});
console.log(revenue.output);

const november = await cog.run(analyst, {
  input: \`Read \${join(dataDir, 'sales-q4.csv')} and use regex to count the November (2025-11-xx) rows.\`,
});
console.log(november.output);
console.log('Tools used:', november.toolCalls.map((call) => call.name).join(', '));

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx built-in-tools.ts',
      repoRun: 'npx tsx examples/core/02-built-in-tools.ts',
      notes: [
        {
          type: 'warning',
          text: 'The file tools read whatever path the model asks for. Give them to agents that work on trusted input only.',
        },
      ],
      example: 'core/02-built-in-tools.ts',
      docs: [
        {
          href: '/docs/tools/built-in',
          label: 'Built-in Tools',
        },
      ],
    },
    {
      id: 'structured-output',
      title: 'Structured Output',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You need typed JSON from the model — a support ticket classified into fields your code can switch on — not free text.',
      points: [
        "Set `responseFormat: { type: 'json_schema', schema }` with a Zod schema",
        'Read the parsed, validated value from `result.structured`',
      ],
      file: 'structured-output.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const ticketSchema = z.object({
  category: z.enum(['billing', 'bug', 'feature-request', 'other']),
  urgency: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
  customerEmail: z.string().optional(),
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const triage = new Agent({
  name: 'ticket-triage',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'Classify the support message. Leave out customerEmail when the message has no email address.',
  responseFormat: { type: 'json_schema', schema: ticketSchema },
  temperature: 0,
});

const result = await cog.run(triage, {
  input:
    'Hi, I was charged twice for my Pro plan this month and need a refund ASAP. — dana@example.com',
});

const ticket = result.structured as z.infer<typeof ticketSchema> | undefined;
if (!ticket) throw new Error(\`The model did not return a valid ticket: \${result.output}\`);

console.log(\`\${ticket.category} / \${ticket.urgency}: \${ticket.summary}\`);
console.log('Reply to:', ticket.customerEmail ?? '(no email)');

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx structured-output.ts',
      notes: [
        {
          type: 'info',
          text: 'An answer that does not match the schema is retried once with the validation error; `structured` is `undefined` if that fails too, so check it before use.',
        },
      ],
      docs: [
        {
          href: '/docs/core/structured-outputs',
          label: 'Structured Outputs',
        },
      ],
    },
    {
      id: 'scaffold-project',
      title: 'Scaffold a Project',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You want a ready-to-run project (package.json, tsconfig, a registry of agents, tools and tests) generated from code, e.g. inside your own tooling.',
      points: [
        'Describe the project as a spec: preset, app, memory, provider, model and package manager',
        '`planProject()` shows the files without writing, `scaffold()` writes, installs, formats and commits',
      ],
      file: 'scaffold-project.ts',
      code: `import { planProject, scaffold } from 'create-cogitator-app';
import { join } from 'node:path';

const spec = {
  name: 'my-agent',
  preset: 'basic',
  app: 'script',
  memory: 'sqlite',
  provider: 'ollama',
  model: 'qwen3.5:4b',
  packageManager: 'pnpm',
} as const;

const plan = planProject(spec);
console.log(\`\${plan.files.length} files, recreate with:\\n  \${plan.command}\`);

const result = await scaffold(spec, {
  directory: join(process.cwd(), 'my-agent'),
  install: false,
  git: false,
});

console.log(result.files.join('\\n'));
console.log('Dependencies:', Object.keys(result.plan.dependencies).join(', '));`,
      install: 'pnpm add create-cogitator-app',
      env: [],
      run: 'npx tsx scaffold-project.ts',
      repoRun: 'npx tsx examples/create-cogitator-app/scaffold-programmatic.ts',
      notes: [
        {
          type: 'tip',
          text: 'From a terminal the same thing is `npx create-cogitator-app my-agent --preset basic --memory sqlite`; without flags it asks for the options interactively.',
        },
      ],
      example: 'create-cogitator-app/scaffold-programmatic.ts',
      docs: [
        {
          href: '/docs/getting-started/scaffolding',
          label: 'Scaffolding',
        },
      ],
    },
  ],
};
