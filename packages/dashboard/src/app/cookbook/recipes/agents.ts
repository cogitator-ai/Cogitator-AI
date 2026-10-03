import type { Section } from './types';

export const agents: Section = {
  id: 'agents',
  title: 'Agents & Tools',
  icon: '🤖',
  description:
    'Cache expensive tools, pause for approval, hand conversations between agents, keep long chats inside the context window.',
  recipes: [
    {
      id: 'tool-caching',
      title: 'Cache Tool Results',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'A tool calls a slow or paid API, and agents keep asking for the same thing. You want repeated calls served from a cache with a TTL.',
      points: [
        'Wrap a tool with `withCache()` (exact matching, TTL, size limit)',
        'Inspect hit rate, invalidate one entry, warm the cache up front',
      ],
      file: 'tool-caching.ts',
      code: `import { tool, withCache } from '@cogitator-ai/core';
import { z } from 'zod';

let apiCalls = 0;

const weatherLookup = tool({
  name: 'weather_lookup',
  description: 'Get current weather for a city',
  parameters: z.object({ city: z.string().describe('City name') }),
  execute: async ({ city }) => {
    apiCalls++;
    return { city, temperature: 12, condition: 'Overcast', fetchedAt: new Date().toISOString() };
  },
});

const cachedWeather = withCache(weatherLookup, {
  strategy: 'exact',
  ttl: '5m',
  storage: 'memory',
  maxSize: 50,
  onHit: (_key, params) => console.log('cache hit', params),
  onMiss: (_key, params) => console.log('cache miss', params),
});

const context = { agentId: 'demo', runId: 'cache-demo', signal: new AbortController().signal };

await cachedWeather.execute({ city: 'London' }, context);
await cachedWeather.execute({ city: 'London' }, context);
console.log('API calls:', apiCalls);

const stats = cachedWeather.cache.stats();
console.log(\`hits=\${stats.hits} misses=\${stats.misses} hitRate=\${(stats.hitRate * 100).toFixed(0)}%\`);

await cachedWeather.cache.invalidate({ city: 'London' });
await cachedWeather.execute({ city: 'London' }, context);
console.log('API calls after invalidate:', apiCalls);

await cachedWeather.cache.warmup([
  {
    params: { city: 'Paris' },
    result: { city: 'Paris', temperature: 14, condition: 'Light Rain', fetchedAt: new Date().toISOString() },
  },
]);
const paris = await cachedWeather.execute({ city: 'Paris' }, context);
console.log(\`Paris (from warmup): \${paris.temperature}°C, API calls still \${apiCalls}\`);

await cachedWeather.cache.clear();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: [],
      run: 'npx tsx tool-caching.ts',
      repoRun: 'npx tsx examples/core/03-tool-caching.ts',
      example: 'core/03-tool-caching.ts',
      docs: [
        {
          href: '/docs/tools/tool-caching',
          label: 'Tool Caching',
        },
      ],
    },
    {
      id: 'approvals',
      title: 'Human Approval for Tools',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Small refunds can go through automatically, but anything over $100 needs a person to approve it — without blocking a server thread while they decide.',
      points: [
        'Mark a tool with `requiresApproval` (a boolean or a function of the arguments)',
        "Get `status: 'paused'` and `pendingApprovals` from the run",
        'Continue later with `cog.resume()` — approve per call or decline all',
      ],
      file: 'approvals.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const orders: Record<string, { total: number; refunded: number }> = {
  'A-1001': { total: 340, refunded: 0 },
  'A-1002': { total: 25, refunded: 0 },
};

const refund = tool({
  name: 'refund_order',
  description: 'Refund part or all of an order to the customer.',
  parameters: z.object({
    order: z.string().describe('Order id, e.g. "A-1001"'),
    amount: z.number().positive().describe('Amount in dollars'),
  }),
  requiresApproval: ({ amount }) => amount > 100,
  sideEffects: ['external'],
  execute: async ({ order, amount }) => {
    const record = orders[order];
    if (!record) throw new Error(\`No order \${order}\`);
    record.refunded += amount;
    return { order, refunded: amount, totalRefunded: record.refunded };
  },
});

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});

const support = new Agent({
  name: 'support',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a support agent. Refund orders with refund_order when asked. Answer briefly.',
  tools: [refund],
  temperature: 0.2,
});

const threadId = 'ticket-7731';

const paused = await cog.run(support, {
  input: 'Order A-1001 arrived broken, please refund all $340.',
  threadId,
});
console.log(paused.status);
for (const call of paused.pendingApprovals ?? []) {
  console.log(\`waiting: \${call.toolName}(\${JSON.stringify(call.arguments)})\`);
}

if (paused.status === 'paused') {
  const approved = await cog.resume(support, threadId, {
    decisions: Object.fromEntries(
      (paused.pendingApprovals ?? []).map((call) => [call.toolCallId, { approved: true as const }])
    ),
  });
  console.log(approved.status, approved.output);
}

const declinedRun = await cog.run(support, {
  input: 'Also refund $200 of order A-1001 for shipping.',
  threadId,
});
if (declinedRun.status === 'paused') {
  const declined = await cog.resume(support, threadId, {
    defaultDecision: { approved: false, reason: 'refunds over $100 need photos of the damage' },
  });
  console.log(declined.output);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx approvals.ts',
      repoRun: 'npx tsx examples/core/14-approvals.ts',
      notes: [
        {
          type: 'info',
          text: 'Resuming needs the thread, so configure `memory`. A durable adapter (Redis, Postgres) lets another process or a later request resume the run.',
        },
      ],
      example: 'core/14-approvals.ts',
      docs: [
        {
          href: '/docs/tools/approvals',
          label: 'Tool Approvals',
        },
      ],
    },
    {
      id: 'handoffs',
      title: 'Agent Handoffs',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'A front-desk agent should route each customer to the right specialist — billing or tech support — and let that specialist answer.',
      points: [
        'List specialists in `handoffs` on the triage agent',
        'Follow the route with `onHandoff` and read `result.finalAgent`',
      ],
      file: 'handoffs.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const invoices: Record<string, { amount: number; status: 'paid' | 'due' }> = {
  'INV-204': { amount: 129, status: 'due' },
};

const lookupInvoice = tool({
  name: 'lookup_invoice',
  description: 'Look up an invoice by its number.',
  parameters: z.object({ invoice: z.string().describe('Invoice number, e.g. "INV-204"') }),
  execute: async ({ invoice }) => invoices[invoice] ?? { error: \`No invoice \${invoice}\` },
});

const serviceStatus = tool({
  name: 'service_status',
  description: 'Current status of the service and known incidents.',
  parameters: z.object({}),
  execute: async () => ({ status: 'degraded', incident: 'Login emails are delayed by ~10 minutes' }),
});

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});

const billing = new Agent({
  name: 'billing',
  description: 'Invoices, payments and refunds',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are the billing specialist. Use lookup_invoice. Answer in two sentences at most.',
  tools: [lookupInvoice],
});

const techSupport = new Agent({
  name: 'tech_support',
  description: 'Login problems, outages and bugs',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are technical support. Check service_status first. Answer in two sentences at most.',
  tools: [serviceStatus],
});

const triage = new Agent({
  name: 'triage',
  model: 'google/gemini-3.5-flash-lite',
  instructions:
    'You greet customers and hand the conversation over to the right specialist. Never answer billing or technical questions yourself.',
  handoffs: [billing, techSupport],
  temperature: 0,
});

for (const input of [
  'How much do I owe on invoice INV-204?',
  "I can't log in, the email with the code never arrives.",
]) {
  const result = await cog.run(triage, {
    input,
    onHandoff: ({ from, to, reason }) => console.log(\`\${from} -> \${to}\${reason ? \` (\${reason})\` : ''}\`),
  });
  console.log(\`\${result.finalAgent ?? 'triage'}: \${result.output}\`);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx handoffs.ts',
      repoRun: 'npx tsx examples/core/15-handoffs.ts',
      example: 'core/15-handoffs.ts',
      docs: [
        {
          href: '/docs/core/agents',
          label: 'Agents',
        },
      ],
    },
    {
      id: 'context-manager',
      title: 'Long Conversations',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'A conversation has outgrown the model’s context window. You want to know how full it is and compress it before the request fails.',
      points: [
        'Measure usage with `checkState()`',
        'Compare the `truncate` and `sliding-window` strategies with `compress()`',
        'Look up a model’s window with `getModelContextLimit()`',
      ],
      file: 'context-manager.ts',
      code: `import { ContextManager } from '@cogitator-ai/core';
import type { Message } from '@cogitator-ai/types';

const MODEL = 'ollama:llama3.1:8b';

function longConversation(turns: number): Message[] {
  const messages: Message[] = [{ role: 'system', content: 'You are a senior software engineer.' }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: \`Turn \${i + 1}: tell me about distributed systems. \${'x'.repeat(200)}\` });
    messages.push({ role: 'assistant', content: \`Turn \${i + 1}: here is what I know. \${'x'.repeat(200)}\` });
  }
  return messages;
}

const conversation = longConversation(80);

for (const strategy of ['truncate', 'sliding-window'] as const) {
  const manager = new ContextManager({
    strategy,
    compressionThreshold: 0.3,
    outputReserve: 0.15,
    windowSize: 10,
  });

  const before = manager.checkState(conversation, MODEL);
  console.log(\`\${strategy}: \${before.utilizationPercent.toFixed(1)}% of the window used, needs compression: \${before.needsCompression}\`);

  const result = await manager.compress(conversation, MODEL);
  const savings = (1 - result.compressedTokens / result.originalTokens) * 100;
  console.log(
    \`  \${conversation.length} -> \${result.messages.length} messages, \` +
      \`\${result.originalTokens} -> \${result.compressedTokens} tokens (\${savings.toFixed(1)}% saved)\`
  );
}

const limits = new ContextManager({ strategy: 'truncate' });
console.log('gemini-3.8-flash window:', limits.getModelContextLimit('google:gemini-3.8-flash'));`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/types',
      env: [],
      run: 'npx tsx context-manager.ts',
      repoRun: 'npx tsx examples/core/04-context-manager.ts',
      example: 'core/04-context-manager.ts',
      docs: [
        {
          href: '/docs/advanced/context-management',
          label: 'Context Management',
        },
      ],
    },
    {
      id: 'model-registry',
      title: 'Model Registry & Pricing',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'You want to pick a model by capability and price — tool support, vision, context size — and estimate what a run will cost.',
      points: [
        'Look up a model and its pricing with `getModel()` and `getPrice()`',
        'Filter with `listModels()`',
        'Refresh the data from LiteLLM with `initializeModels()`, falling back to the built-in list offline',
      ],
      file: 'model-registry.ts',
      code: `import { getModel, getModelRegistry, getPrice, initializeModels, listModels, shutdownModels } from '@cogitator-ai/models';

const claude = getModel('claude-sonnet-5-5');
console.log(\`\${claude?.displayName}: \${claude?.contextWindow} tokens, $\${claude?.pricing.input}/M input\`);

const price = getPrice('gpt-6-luna');
if (price) {
  const cost = (50_000 / 1_000_000) * price.input + (10_000 / 1_000_000) * price.output;
  console.log(\`50k in + 10k out on GPT-6 Luna: $\${cost.toFixed(4)}\`);
}

const cheapToolModels = listModels({
  supportsTools: true,
  maxPricePerMillion: 2,
  excludeDeprecated: true,
});
for (const model of cheapToolModels.slice(0, 5)) {
  console.log(\`  \${model.id} (\${model.provider})\`);
}

const visionModels = listModels({ supportsVision: true, minContextWindow: 200_000, excludeDeprecated: true });
console.log('Vision models with 200k+ context:', visionModels.map((model) => model.id).join(', '));

try {
  await initializeModels();
  console.log('Models after fetching LiteLLM data:', getModelRegistry().getModelCount());
} catch {
  console.log('Offline: using the built-in model list');
}

shutdownModels();`,
      install: 'pnpm add @cogitator-ai/models',
      env: [],
      run: 'npx tsx model-registry.ts',
      repoRun: 'npx tsx examples/core/13-model-registry.ts',
      example: 'core/13-model-registry.ts',
      docs: [
        {
          href: '/docs/core/model-registry',
          label: 'Model Registry',
        },
      ],
    },
  ],
};
