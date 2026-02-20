import { requireEnv, header, section } from '../_shared/setup.js';
import {
  HybridSearch,
  BM25Index,
  InMemoryEmbeddingAdapter,
  GoogleEmbeddingService,
} from '@cogitator-ai/memory';

const notes = [
  {
    id: 'note-1',
    content:
      'TypeScript 5.4 introduces the NoInfer utility type, which prevents unwanted type inference in generic functions. This is useful when you want to force callers to be explicit about type parameters.',
  },
  {
    id: 'note-2',
    content:
      'React Server Components allow rendering components on the server, reducing the JavaScript bundle sent to the client. They integrate with Suspense for streaming HTML.',
  },
  {
    id: 'note-3',
    content:
      'PostgreSQL 16 adds SQL/JSON constructors and identity features. The new pg_stat_io view provides detailed I/O statistics for better performance monitoring.',
  },
  {
    id: 'note-4',
    content:
      'Bun is a JavaScript runtime built on JavaScriptCore (Safari engine) instead of V8. It aims to be a drop-in replacement for Node.js with significantly faster startup and execution times.',
  },
  {
    id: 'note-5',
    content:
      'The CAP theorem states that a distributed system can only guarantee two of three properties: Consistency, Availability, and Partition tolerance. Most modern systems choose AP or CP.',
  },
  {
    id: 'note-6',
    content:
      'Vector databases like Qdrant, Pinecone, and Weaviate store high-dimensional embeddings for similarity search. They are essential for building RAG (Retrieval Augmented Generation) pipelines.',
  },
  {
    id: 'note-7',
    content:
      'Rust ownership model eliminates data races at compile time. The borrow checker ensures that references are always valid, preventing use-after-free and double-free bugs.',
  },
  {
    id: 'note-8',
    content:
      'Docker containers share the host OS kernel, making them lighter than virtual machines. Container images are built in layers, enabling efficient caching and distribution.',
  },
  {
    id: 'note-9',
    content:
      'GraphQL provides a type-safe query language for APIs. Unlike REST, clients can request exactly the fields they need, avoiding over-fetching and under-fetching problems.',
  },
  {
    id: 'note-10',
    content:
      'Kubernetes orchestrates container deployments across clusters. It handles scaling, load balancing, rolling updates, and self-healing through declarative configuration.',
  },
  {
    id: 'note-11',
    content:
      'WebAssembly (WASM) allows running compiled languages like C, Rust, and Go in the browser at near-native speed. WASI extends this to server-side use cases.',
  },
  {
    id: 'note-12',
    content:
      'BM25 is a probabilistic ranking function used in information retrieval. It considers term frequency, inverse document frequency, and document length normalization.',
  },
];

async function main() {
  header('03 — Semantic Search: Hybrid BM25 + Vector Search');

  const apiKey = requireEnv('GOOGLE_API_KEY');

  section('1. BM25 keyword search (no embeddings needed)');

  const bm25 = new BM25Index();
  for (const note of notes) {
    bm25.addDocument(note);
  }
  console.log(`Indexed ${bm25.size} documents in BM25\n`);

  const keywordQueries = [
    'TypeScript type inference',
    'container orchestration',
    'ranking function',
  ];

  for (const query of keywordQueries) {
    const results = bm25.search(query, 3);
    console.log(`Query: "${query}"`);
    for (const r of results) {
      console.log(`  [${r.score.toFixed(3)}] ${r.content.slice(0, 80)}...`);
    }
    console.log();
  }

  section('2. Hybrid search setup (BM25 + vector)');

  const embeddingService = new GoogleEmbeddingService({ apiKey, model: 'gemini-embedding-001' });
  const embeddingAdapter = new InMemoryEmbeddingAdapter();

  console.log('Generating embeddings for all notes...');
  for (const note of notes) {
    const vector = await embeddingService.embed(note.content);
    await embeddingAdapter.addEmbedding({
      sourceId: note.id,
      sourceType: 'document',
      content: note.content,
      vector,
    });
  }
  console.log(`Stored ${embeddingAdapter.size} embeddings\n`);

  const hybridSearch = new HybridSearch({
    embeddingAdapter,
    embeddingService,
    defaultWeights: { bm25: 0.4, vector: 0.6 },
  });

  for (const note of notes) {
    hybridSearch.indexDocument(note.id, note.content);
  }

  section('3. Compare search strategies');

  const searchQueries = [
    'How do I make my JavaScript app faster?',
    'database performance monitoring',
    'memory safety without garbage collection',
  ];

  for (const query of searchQueries) {
    console.log(`\nQuery: "${query}"\n`);

    const strategies = ['keyword', 'vector', 'hybrid'] as const;
    for (const strategy of strategies) {
      const result = await hybridSearch.search({ query, strategy, limit: 3, threshold: 0.3 });
      if (!result.success) continue;

      console.log(`  ${strategy.toUpperCase()}:`);
      for (const r of result.data) {
        const scores = [
          r.vectorScore !== undefined ? `vec=${r.vectorScore.toFixed(3)}` : null,
          r.keywordScore !== undefined ? `kw=${r.keywordScore.toFixed(3)}` : null,
        ]
          .filter(Boolean)
          .join(' ');
        const scoreInfo = scores ? ` (${scores})` : '';
        console.log(`    [${r.score.toFixed(3)}${scoreInfo}] ${r.content.slice(0, 70)}...`);
      }
    }
  }

  section('4. Custom weights: keyword-heavy vs vector-heavy');

  const query = 'distributed systems consistency';

  const keywordHeavy = await hybridSearch.search({
    query,
    strategy: 'hybrid',
    weights: { bm25: 0.8, vector: 0.2 },
    limit: 3,
    threshold: 0.3,
  });

  const vectorHeavy = await hybridSearch.search({
    query,
    strategy: 'hybrid',
    weights: { bm25: 0.2, vector: 0.8 },
    limit: 3,
    threshold: 0.3,
  });

  console.log(`Query: "${query}"\n`);

  console.log('Keyword-heavy (bm25=0.8, vector=0.2):');
  for (const r of keywordHeavy.data!) {
    console.log(`  [${r.score.toFixed(3)}] ${r.content.slice(0, 70)}...`);
  }

  console.log('\nVector-heavy (bm25=0.2, vector=0.8):');
  for (const r of vectorHeavy.data!) {
    console.log(`  [${r.score.toFixed(3)}] ${r.content.slice(0, 70)}...`);
  }

  console.log('\nDone.');
}

main();
