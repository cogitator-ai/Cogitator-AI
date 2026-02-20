import { createCogitator, DEFAULT_MODEL, header, requireEnv, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { RAGPipelineBuilder, TextLoader, createSearchTool } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, GoogleEmbeddingService } from '@cogitator-ai/memory';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const KNOWLEDGE_BASE = [
  {
    filename: 'cogitator-overview.txt',
    content: `Cogitator is a self-hosted, production-grade AI agent runtime for TypeScript.
It provides orchestration for LLM swarms and autonomous agents. Key features include
multi-provider LLM support (OpenAI, Anthropic, Google, Ollama), type-safe tool
execution with Zod schemas, streaming responses, and built-in memory management.
Cogitator runs entirely on your infrastructure with no external dependencies.`,
  },
  {
    filename: 'cogitator-rag.txt',
    content: `The @cogitator-ai/rag package adds retrieval-augmented generation to Cogitator agents.
It supports multiple document loaders (text, markdown, JSON, CSV, HTML, PDF, web pages),
three chunking strategies (fixed-size, recursive, semantic), and four retrieval methods
(similarity, MMR, hybrid, multi-query). Documents are embedded using configurable
embedding services and stored in vector databases for fast semantic search.`,
  },
  {
    filename: 'cogitator-memory.txt',
    content: `The @cogitator-ai/memory package provides persistent memory for Cogitator agents.
It includes adapters for Redis, PostgreSQL, SQLite, MongoDB, and Qdrant. The memory
system supports conversation threads, semantic search over past interactions, and
a knowledge graph with entity extraction. The context builder automatically selects
relevant memories to include in agent prompts.`,
  },
];

async function main() {
  header('03 — Agent with RAG Tools');
  const apiKey = requireEnv('GOOGLE_API_KEY');

  section('1. Build knowledge base');

  const embeddingAdapter = new InMemoryEmbeddingAdapter();
  const embeddingService = new GoogleEmbeddingService({ apiKey });

  const pipeline = new RAGPipelineBuilder()
    .withLoader(new TextLoader())
    .withEmbeddingService(embeddingService)
    .withEmbeddingAdapter(embeddingAdapter)
    .withConfig({
      chunking: { strategy: 'recursive', chunkSize: 400, chunkOverlap: 50 },
      retrieval: { strategy: 'similarity', topK: 3, threshold: 0.3 },
    })
    .build();

  const tempDir = join(tmpdir(), `cogitator-rag-agent-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  for (const doc of KNOWLEDGE_BASE) {
    await writeFile(join(tempDir, doc.filename), doc.content, 'utf-8');
  }

  const stats = await pipeline.ingest(tempDir);
  console.log(`Knowledge base ready: ${stats.documents} docs, ${stats.chunks} chunks`);

  await rm(tempDir, { recursive: true, force: true });

  section('2. Create agent with RAG tools');

  const ragSearch = createSearchTool(pipeline);

  const searchKnowledgeBase = tool({
    name: ragSearch.name,
    description: ragSearch.description,
    parameters: z.object({
      query: z.string().describe('Search query for the knowledge base'),
      limit: z.number().int().positive().optional().describe('Max results to return'),
      threshold: z.number().min(0).max(1).optional().describe('Minimum similarity score'),
    }),
    execute: async (params) => ragSearch.execute(params),
  });

  const cog = createCogitator();

  const agent = new Agent({
    name: 'docs-assistant',
    model: DEFAULT_MODEL,
    instructions: `You are a Cogitator documentation assistant. Use the rag_search tool to find
information in the knowledge base before answering questions. Always cite what you found.
Be concise — 2-3 sentences max.`,
    tools: [searchKnowledgeBase],
    temperature: 0.3,
    maxIterations: 5,
  });

  console.log(`Agent "${agent.name}" ready with ${agent.tools.length} tool(s).`);

  section('3. Ask questions');

  const questions = [
    'What document loaders does the RAG package support?',
    'How does Cogitator handle memory persistence?',
    'What LLM providers can I use with Cogitator?',
  ];

  for (const question of questions) {
    console.log(`\nUser: ${question}`);
    const result = await cog.run(agent, { input: question });
    console.log(`Assistant: ${result.output}`);

    if (result.toolCalls.length > 0) {
      console.log(`  (used ${result.toolCalls.map((tc) => tc.name).join(', ')})`);
    }
  }

  await cog.close();
  console.log('\nDone.');
}

main();
