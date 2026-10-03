import { highlightCode } from '../../highlight';
import type { ExplorerFeature } from './types';

const MEMORY_CODE = `
const cog = new Cogitator({
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL! },
    embedding: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
    contextBuilder: {
      maxTokens: 8000,
      strategy: 'hybrid',
      includeFacts: true,
      includeSemanticContext: true,
    },
  },
});

await cog.run(concierge, { input: 'Book my usual hotel', threadId: 'trip-42', userId: 'alice' });
`;

const RAG_CODE = `
const pipeline = new RAGPipelineBuilder()
  .withLoader(new MarkdownLoader())
  .withEmbeddingService(new OpenAIEmbeddingService({ apiKey: process.env.OPENAI_API_KEY! }))
  .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
  .withReranker(new CohereReranker({ apiKey: process.env.COHERE_API_KEY! }))
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 512, chunkOverlap: 50 },
    retrieval: { strategy: 'similarity', topK: 12 },
    reranking: { enabled: true, topN: 3 },
  })
  .build();

await pipeline.ingest('./handbook');
const [search] = ragTools(pipeline);
const hr = new Agent({ name: 'hr', instructions: 'Cite the source file.', tools: [tool(search)] });
`;

const MCP_CODE = `
const { tools: github } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
});

const triage = new Agent({
  name: 'triage',
  description: 'Labels new GitHub issues and drafts a first reply.',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'Read the issue, label it and draft a reply.',
  tools: github,
});

await serveAgents(cog, [triage]);
`;

const A2A_CODE = `
const server = new A2AServer({
  agents: { researcher },
  cogitator: cog,
  cardUrl: 'https://research.internal',
});
app.use(a2aExpress(server));

const remote = new A2AClient('https://research.internal');
const card = await remote.agentCard();

for await (const event of remote.sendMessageStream({
  role: 'user',
  parts: [{ type: 'text', text: 'Summarize Q3 churn drivers' }],
})) {
  if (event.type === 'artifact-update') console.log(card.name, event.artifact.parts);
}
`;

const CHANNELS_CODE = `
const gateway = new Gateway({
  agent: assistant,
  cogitator: cog,
  memory,
  channels: [
    telegramChannel({ token: process.env.TG_TOKEN! }),
    discordChannel({ token: process.env.DISCORD_TOKEN!, mentionOnly: true }),
    slackChannel({
      token: process.env.SLACK_BOT_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      appToken: process.env.SLACK_APP_TOKEN!,
    }),
    whatsappChannel({ sessionPath: '.cogitator/whatsapp' }),
    webchatChannel({ port: 3100 }),
  ],
});

await gateway.start();
`;

const VOICE_CODE = `
const voice = new VoiceAgent({
  mode: 'pipeline',
  agent: createCogitatorRunner(cog, receptionist),
  stt: new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY! }),
  tts: new ElevenLabsTTS({ apiKey: process.env.ELEVENLABS_API_KEY! }),
  vad: new EnergyVAD(),
});

await voice.listen(8080);
`;

const BROWSER_CODE = `
const session = new BrowserSession({ headless: true, stealth: true });

const scout = new Agent({
  name: 'price-scout',
  model: 'openai/gpt-5.5',
  instructions: 'Find the product page and extract its price and stock.',
  tools: browserTools(session, { modules: ['navigation', 'interaction', 'extraction'] }),
});

const run = await cog.run(scout, { input: 'Check the price of the Halcyon desk lamp' });
console.log(run.output);
await session.close();
`;

const EVALS_CODE = `
const comparison = new EvalComparison({
  dataset: await Dataset.fromJsonl('./evals/support.jsonl'),
  targets: {
    baseline: { agent: support, cogitator: cog },
    challenger: { agent: supportV2, cogitator: cog },
  },
  metrics: [contains(), faithfulness()],
  judge: { model: 'openai/gpt-5.5', temperature: 0 },
});

const { summary } = await comparison.run();
console.log(summary.winner, summary.metrics.faithfulness.pValue);
`;

/** Group A of the feature explorer: memory, RAG, MCP, A2A, channels, voice, browser, evals. */
export async function featuresA(): Promise<ExplorerFeature[]> {
  const [memory, rag, mcp, a2a, channels, voice, browser, evals] = await Promise.all(
    [
      MEMORY_CODE,
      RAG_CODE,
      MCP_CODE,
      A2A_CODE,
      CHANNELS_CODE,
      VOICE_CODE,
      BROWSER_CODE,
      EVALS_CODE,
    ].map((code) => highlightCode(code))
  );

  return [
    {
      id: 'memory',
      pkg: '@cogitator-ai/memory',
      title: 'Memory & context',
      summary:
        'Every run gets a context built to a token budget: recent history, long-term facts and semantic hits, on Postgres, Redis, SQLite, MongoDB or Qdrant.',
      href: '/docs/memory',
      code: memory,
    },
    {
      id: 'rag',
      pkg: '@cogitator-ai/rag',
      title: 'RAG',
      summary:
        'Load, chunk, embed, retrieve and rerank your documents, then hand the agent a search tool that returns sources it can cite.',
      href: '/docs/rag',
      code: rag,
    },
    {
      id: 'mcp',
      pkg: '@cogitator-ai/mcp',
      title: 'MCP, both ways',
      summary:
        'Give agents the tools of any MCP server, and serve your agents to Claude Desktop, Cursor or Claude Code with one call.',
      href: '/docs/integrations/mcp',
      code: mcp,
    },
    {
      id: 'a2a',
      pkg: '@cogitator-ai/a2a',
      title: 'Agent-to-Agent',
      summary:
        'Expose agents over the A2A protocol with generated agent cards, and call remote agents from any framework with streaming results.',
      href: '/docs/integrations/a2a',
      code: a2a,
    },
    {
      id: 'channels',
      pkg: '@cogitator-ai/channels',
      title: 'Messaging channels',
      summary:
        'One assistant on Telegram, Discord, Slack, WhatsApp and web chat, with sessions, streaming replies and tool approvals right in the chat.',
      href: '/docs/channels/gateway',
      code: channels,
    },
    {
      id: 'voice',
      pkg: '@cogitator-ai/voice',
      title: 'Voice agents',
      summary:
        'Speech in, speech out: an STT, agent and TTS pipeline with voice activity detection, or native realtime speech with OpenAI and Gemini.',
      href: '/docs/voice',
      code: voice,
    },
    {
      id: 'browser',
      pkg: '@cogitator-ai/browser',
      title: 'Browser agents',
      summary:
        'Playwright-backed tools to navigate, click, fill forms and extract data, with stealth mode and accessibility-tree vision.',
      href: '/docs/browser',
      code: browser,
    },
    {
      id: 'evals',
      pkg: '@cogitator-ai/evals',
      title: 'Evals',
      summary:
        'Run agents over datasets with deterministic and LLM-judge metrics, and A/B two versions with a significance test before you ship.',
      href: '/docs/evals',
      code: evals,
    },
  ];
}
