import type { Section } from './types';

export const memory: Section = {
  id: 'memory',
  title: 'Memory & RAG',
  icon: '💾',
  description:
    'Threads that remember, token-aware context, hybrid search, knowledge graphs and retrieval-augmented agents.',
  recipes: [
    {
      id: 'conversation-memory',
      title: 'Conversation Memory',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'Your chatbot forgets the user’s name between messages. You want every turn of a thread remembered.',
      points: [
        'Enable `memory` on `Cogitator` with a context-builder budget',
        'Pass the same `threadId` on every run',
        'Read the stored messages back from `cog.memory`',
      ],
      file: 'conversation-memory.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { unwrap } from '@cogitator-ai/memory';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const cog = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: {
    adapter: 'memory',
    contextBuilder: { maxTokens: 4000, strategy: 'recent' },
  },
});

const agent = new Agent({
  name: 'memory-bot',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant that remembers what the user tells you. Be concise.',
  temperature: 0.3,
});

const threadId = 'user-42';

for (const input of [
  'My name is Alex and I live in Berlin.',
  'I have two cats named Luna and Mochi.',
  'What are my cats called and where do I live?',
]) {
  const result = await cog.run(agent, { input, threadId });
  console.log(\`User: \${input}\\nAssistant: \${result.output}\\n\`);
}

if (cog.memory) {
  const entries = unwrap(await cog.memory.getEntries({ threadId }));
  console.log(\`Thread "\${threadId}" holds \${entries.length} messages\`);
}

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/memory',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx conversation-memory.ts',
      repoRun: 'npx tsx examples/memory/01-basic-memory.ts',
      example: 'memory/01-basic-memory.ts',
      docs: [
        {
          href: '/docs/memory',
          label: 'Memory',
        },
      ],
    },
    {
      id: 'context-builder',
      title: 'Token-Aware Context',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'You assemble prompts yourself and need the most recent history that fits a token budget, with the system prompt always included.',
      points: [
        'Store messages with `InMemoryAdapter` and `countTokens()`',
        'Build the context with `ContextBuilder` for different budgets and read the truncation metadata',
      ],
      file: 'context-builder.ts',
      code: `import { ContextBuilder, InMemoryAdapter, countTokens } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.connect();

const agentId = 'travel-agent';
const threadId = 'trip-to-japan';
await memory.createThread(agentId, {}, threadId);

const conversation = [
  { role: 'user' as const, content: 'I want to plan a trip to Japan in April. Budget is $3000.' },
  { role: 'assistant' as const, content: 'April is cherry blossom season. Split two weeks between Tokyo, Kyoto, Osaka and Hakone.' },
  { role: 'user' as const, content: 'Is the Japan Rail Pass worth it?' },
  { role: 'assistant' as const, content: 'Yes. A 14-day pass covers the Shinkansen and pays off on this route. Buy it before you travel.' },
  { role: 'user' as const, content: 'Any food recommendations?' },
  { role: 'assistant' as const, content: 'Ramen in Tokyo, okonomiyaki in Osaka, matcha desserts in Kyoto. Budget $30-50 a day.' },
];

for (const message of conversation) {
  await memory.addEntry({ threadId, message, tokenCount: countTokens(message.content) });
}

for (const maxTokens of [120, 150, 220]) {
  const builder = new ContextBuilder(
    { maxTokens, strategy: 'recent', includeSystemPrompt: true },
    { memoryAdapter: memory }
  );
  const context = await builder.build({
    threadId,
    agentId,
    systemPrompt: 'You are a travel planning assistant.',
  });
  console.log(
    \`\${maxTokens} tokens: \${context.metadata.includedMessageCount}/\${context.metadata.originalMessageCount} messages, \` +
      \`\${context.tokenCount} tokens, truncated=\${context.truncated}\`
  );
}

await memory.disconnect();`,
      install: 'pnpm add @cogitator-ai/memory',
      env: [],
      run: 'npx tsx context-builder.ts',
      repoRun: 'npx tsx examples/memory/02-context-builder.ts',
      example: 'memory/02-context-builder.ts',
      docs: [
        {
          href: '/docs/memory',
          label: 'Memory',
        },
      ],
    },
    {
      id: 'hybrid-search',
      title: 'Hybrid Search',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'Keyword search misses paraphrases and vector search misses exact terms. You want both, weighted.',
      points: [
        'Rank with `BM25Index` alone',
        'Embed notes with `GoogleEmbeddingService` into `InMemoryEmbeddingAdapter`',
        'Compare `keyword`, `vector` and `hybrid` with `HybridSearch`',
      ],
      file: 'hybrid-search.ts',
      code: `import { BM25Index, GoogleEmbeddingService, HybridSearch, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const notes = [
  { id: 'note-1', content: 'TypeScript 5.4 introduces the NoInfer utility type for generic functions.' },
  { id: 'note-2', content: 'Bun is a JavaScript runtime built on JavaScriptCore with fast startup times.' },
  { id: 'note-3', content: 'PostgreSQL 16 adds the pg_stat_io view for detailed I/O statistics.' },
  { id: 'note-4', content: 'The CAP theorem: a distributed system guarantees two of consistency, availability, partition tolerance.' },
  { id: 'note-5', content: 'Rust ownership eliminates data races at compile time; the borrow checker prevents use-after-free.' },
];

const bm25 = new BM25Index();
for (const note of notes) bm25.addDocument(note);
console.log('BM25:', bm25.search('type inference', 2).map((hit) => hit.content));

const embeddingService = new GoogleEmbeddingService({ apiKey, model: 'gemini-embedding-001' });
const embeddingAdapter = new InMemoryEmbeddingAdapter();
for (const note of notes) {
  await embeddingAdapter.addEmbedding({
    sourceId: note.id,
    sourceType: 'document',
    content: note.content,
    vector: await embeddingService.embed(note.content),
  });
}

const search = new HybridSearch({
  embeddingAdapter,
  embeddingService,
  defaultWeights: { bm25: 0.4, vector: 0.6 },
});
for (const note of notes) search.indexDocument(note.id, note.content);

const query = 'memory safety without garbage collection';
for (const strategy of ['keyword', 'vector', 'hybrid'] as const) {
  const result = await search.search({ query, strategy, limit: 2, threshold: 0.3 });
  if (!result.success) continue;
  console.log(strategy, result.data.map((hit) => \`[\${hit.score.toFixed(3)}] \${hit.content.slice(0, 50)}\`));
}`,
      install: 'pnpm add @cogitator-ai/memory',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx hybrid-search.ts',
      repoRun: 'npx tsx examples/memory/03-semantic-search.ts',
      example: 'memory/03-semantic-search.ts',
      docs: [
        {
          href: '/docs/memory/hybrid-search',
          label: 'Hybrid Search',
        },
      ],
    },
    {
      id: 'knowledge-graph',
      title: 'Knowledge Graph',
      difficulty: 'advanced',
      time: '20 min',
      problem:
        'You want facts about people, places and organizations pulled out of text and stored as a graph you can traverse.',
      points: [
        'Extract entities and relations with `LLMEntityExtractor`',
        'Store them in `SQLiteGraphAdapter` and walk neighbours and multi-hop paths',
        'Derive new edges with `GraphInferenceEngine`',
      ],
      file: 'knowledge-graph.ts',
      code: `import { createLLMBackend } from '@cogitator-ai/core';
import {
  GraphInferenceEngine,
  LLMEntityExtractor,
  SQLiteGraphAdapter,
  unwrap,
  type LLMBackendMinimal,
} from '@cogitator-ai/memory';
import type { GraphNode } from '@cogitator-ai/types';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const google = createLLMBackend('google', { providers: { google: { apiKey } } });
const llm: LLMBackendMinimal = {
  async chat({ messages, responseFormat }) {
    const response = await google.chat({ model: 'gemini-3.5-flash-lite', messages, responseFormat });
    return { content: response.content };
  },
};

const paragraphs = [
  'Marie Curie was a Polish-born physicist who worked at the University of Paris. She won the Nobel Prize twice.',
  'Pierre Curie was a French physicist and husband of Marie Curie. Together they discovered polonium and radium.',
  'Irene Joliot-Curie, daughter of Marie and Pierre Curie, worked at the Radium Institute in Paris.',
];

const agentId = 'kg-agent';
const extractor = new LLMEntityExtractor(llm, { minConfidence: 0.6 });
const graph = new SQLiteGraphAdapter({ path: ':memory:' });
await graph.initialize();

const nodes = new Map<string, GraphNode>();
for (const text of paragraphs) {
  const { entities, relations } = await extractor.extract(text, {
    agentId,
    existingEntities: [...nodes.values()].map((node) => node.name),
  });

  for (const entity of entities) {
    const key = entity.name.toLowerCase();
    if (nodes.has(key)) continue;
    const node = unwrap(
      await graph.addNode({
        agentId,
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases ?? [],
        description: entity.description,
        properties: {},
        confidence: entity.confidence,
        source: 'extracted',
      })
    );
    nodes.set(key, node);
  }

  for (const relation of relations) {
    const source = nodes.get(relation.sourceEntity.toLowerCase());
    const target = nodes.get(relation.targetEntity.toLowerCase());
    if (!source || !target) continue;
    await graph.addEdge({
      agentId,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      type: relation.type,
      label: relation.label,
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: relation.confidence,
      source: 'extracted',
    });
  }
}

const stats = unwrap(await graph.getGraphStats(agentId));
console.log(\`\${stats.nodeCount} nodes, \${stats.edgeCount} edges\`, stats.nodesByType);

const marie = nodes.get('marie curie');
if (marie) {
  for (const { node, edge } of unwrap(await graph.getNeighbors(marie.id))) {
    console.log(\`Marie Curie —\${edge.type}— \${node.name}\`);
  }
  const reachable = unwrap(
    await graph.traverse({ agentId, startNodeId: marie.id, maxDepth: 2, direction: 'both' })
  );
  console.log('Within 2 hops:', reachable.visitedNodes.map((node) => node.name).join(', '));
}

const inference = new GraphInferenceEngine(graph);
const inferred = await inference.infer(agentId);
console.log(\`Inferred \${inferred.length} new relations\`);
await inference.materialize(inferred);

await graph.close();`,
      install:
        'pnpm add @cogitator-ai/core @cogitator-ai/memory @cogitator-ai/types better-sqlite3',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx knowledge-graph.ts',
      repoRun: 'npx tsx examples/memory/04-knowledge-graph.ts',
      notes: [
        {
          type: 'info',
          text: 'The example in the repo implements its own in-memory `GraphAdapter`; this recipe uses the built-in `SQLiteGraphAdapter` with `:memory:` — pass a file path to keep the graph.',
        },
      ],
      example: 'memory/04-knowledge-graph.ts',
      docs: [
        {
          href: '/docs/memory/knowledge-graphs',
          label: 'Knowledge Graphs',
        },
      ],
    },
    {
      id: 'rag-pipeline',
      title: 'RAG Pipeline',
      difficulty: 'medium',
      time: '10 min',
      problem: 'You have a folder of documents and want to ask questions against it.',
      points: [
        'Assemble loader, embeddings and store with `RAGPipelineBuilder`',
        'Ingest a directory and query by similarity',
      ],
      file: 'rag-pipeline.ts',
      code: `import { GoogleEmbeddingService, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';
import { RAGPipelineBuilder, TextLoader } from '@cogitator-ai/rag';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const docsDir = join(process.cwd(), 'knowledge');
await mkdir(docsDir, { recursive: true });
await writeFile(
  join(docsDir, 'typescript.txt'),
  'TypeScript adds static type checking to JavaScript at compile time. It supports interfaces, generics and type inference.'
);
await writeFile(
  join(docsDir, 'space.txt'),
  'The James Webb Space Telescope orbits the Sun at the L2 point, about 1.5 million kilometers from Earth.'
);

const pipeline = new RAGPipelineBuilder()
  .withLoader(new TextLoader())
  .withEmbeddingService(new GoogleEmbeddingService({ apiKey }))
  .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 300, chunkOverlap: 50 },
    retrieval: { strategy: 'similarity', topK: 3, threshold: 0.3 },
  })
  .build();

const ingested = await pipeline.ingest(docsDir);
console.log(\`Ingested \${ingested.documents} documents -> \${ingested.chunks} chunks\`);

for (const question of ['How does TypeScript improve JavaScript?', 'How far is JWST from Earth?']) {
  const results = await pipeline.query(question);
  console.log(question);
  for (const result of results) {
    console.log(\`  [\${result.score.toFixed(3)}] \${result.content.slice(0, 80)}\`);
  }
}`,
      install: 'pnpm add @cogitator-ai/memory @cogitator-ai/rag',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx rag-pipeline.ts',
      repoRun: 'npx tsx examples/rag/01-basic-retrieval.ts',
      example: 'rag/01-basic-retrieval.ts',
      docs: [
        {
          href: '/docs/rag',
          label: 'RAG',
        },
      ],
    },
    {
      id: 'chunking',
      title: 'Chunking Strategies',
      difficulty: 'easy',
      time: '5 min',
      problem:
        'Retrieval quality depends on how documents are split. You want to compare the splitters on your own text.',
      points: [
        'Compare `FixedSizeChunker`, `RecursiveChunker` and the embedding-based `SemanticChunker`',
      ],
      file: 'chunking.ts',
      code: `import { GoogleEmbeddingService } from '@cogitator-ai/memory';
import { FixedSizeChunker, RecursiveChunker, SemanticChunker } from '@cogitator-ai/rag';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const text = \`Early AI systems relied on hand-crafted rules and symbolic reasoning.

The shift to machine learning in the 1990s changed everything. Researchers trained algorithms on data instead of programming rules.

The transformer architecture, introduced in 2017, revolutionized natural language processing with self-attention.

Retrieval-augmented generation retrieves relevant documents at inference time, which reduces hallucinations.\`;

function describe(name: string, chunks: { content: string }[]) {
  const sizes = chunks.map((chunk) => chunk.content.length);
  console.log(\`\${name}: \${chunks.length} chunks, \${Math.min(...sizes)}–\${Math.max(...sizes)} chars\`);
}

describe('fixed', new FixedSizeChunker({ chunkSize: 200, chunkOverlap: 30 }).chunk(text, 'doc-1'));
describe('recursive', new RecursiveChunker({ chunkSize: 200, chunkOverlap: 30 }).chunk(text, 'doc-1'));

const semantic = new SemanticChunker({
  embeddingService: new GoogleEmbeddingService({ apiKey }),
  breakpointThreshold: 0.5,
  minChunkSize: 100,
  maxChunkSize: 600,
});
describe('semantic', await semantic.chunk(text, 'doc-1'));`,
      install: 'pnpm add @cogitator-ai/memory @cogitator-ai/rag',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx chunking.ts',
      repoRun: 'npx tsx examples/rag/02-chunking-strategies.ts',
      example: 'rag/02-chunking-strategies.ts',
      docs: [
        {
          href: '/docs/rag/chunking',
          label: 'Chunking',
        },
      ],
    },
    {
      id: 'rag-agent',
      title: 'Agent with RAG',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'Instead of stuffing documents into the prompt, the agent should search the knowledge base when it needs to.',
      points: ['Turn a pipeline into a tool with `createSearchTool()` and give it to an agent'],
      file: 'rag-agent.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { GoogleEmbeddingService, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';
import { RAGPipelineBuilder, TextLoader, createSearchTool } from '@cogitator-ai/rag';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const docsDir = join(process.cwd(), 'knowledge');
await mkdir(docsDir, { recursive: true });
await writeFile(
  join(docsDir, 'memory.txt'),
  'The @cogitator-ai/memory package has adapters for Redis, PostgreSQL, SQLite, MongoDB and Qdrant.'
);
await writeFile(
  join(docsDir, 'rag.txt'),
  'The @cogitator-ai/rag package loads text, markdown, JSON, CSV, HTML, PDF and web pages.'
);

const pipeline = new RAGPipelineBuilder()
  .withLoader(new TextLoader())
  .withEmbeddingService(new GoogleEmbeddingService({ apiKey }))
  .withEmbeddingAdapter(new InMemoryEmbeddingAdapter())
  .withConfig({
    chunking: { strategy: 'recursive', chunkSize: 400, chunkOverlap: 50 },
    retrieval: { strategy: 'similarity', topK: 3, threshold: 0.3 },
  })
  .build();
await pipeline.ingest(docsDir);

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const assistant = new Agent({
  name: 'docs-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions:
    'Use the rag_search tool to find information before answering. Cite what you found. Be concise.',
  tools: [tool(createSearchTool(pipeline))],
  temperature: 0.3,
  maxIterations: 5,
});

const result = await cog.run(assistant, { input: 'Which databases can Cogitator memory use?' });
console.log(result.output);
console.log('Tools:', result.toolCalls.map((call) => call.name));

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/memory @cogitator-ai/rag',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx rag-agent.ts',
      repoRun: 'npx tsx examples/rag/03-agent-with-rag.ts',
      example: 'rag/03-agent-with-rag.ts',
      docs: [
        {
          href: '/docs/rag/retrieval',
          label: 'Retrieval',
        },
      ],
    },
  ],
};
