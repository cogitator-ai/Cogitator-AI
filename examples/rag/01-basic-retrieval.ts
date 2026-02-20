import { header, requireEnv, section } from '../_shared/setup.js';
import { RAGPipelineBuilder, TextLoader } from '@cogitator-ai/rag';
import { InMemoryEmbeddingAdapter, GoogleEmbeddingService } from '@cogitator-ai/memory';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DOCUMENTS = [
  {
    filename: 'typescript.txt',
    content: `TypeScript is a strongly typed programming language that builds on JavaScript.
It adds static type checking at compile time, which helps catch errors before runtime.
TypeScript supports interfaces, generics, union types, and type inference.
The compiler transforms TypeScript code into plain JavaScript that runs anywhere.
Many large-scale projects like Angular, Deno, and VS Code are written in TypeScript.`,
  },
  {
    filename: 'cooking.txt',
    content: `The Maillard reaction is a chemical process between amino acids and reducing sugars
that gives browned food its distinctive flavor. It occurs at temperatures above 140°C.
Caramelization is a different process that involves the pyrolysis of sugar alone.
Both reactions are essential for developing complex flavors in roasted coffee,
seared steaks, toasted bread, and baked cookies.`,
  },
  {
    filename: 'space.txt',
    content: `The James Webb Space Telescope orbits the Sun at the L2 Lagrange point,
approximately 1.5 million kilometers from Earth. Its primary mirror is 6.5 meters
in diameter, made of 18 gold-coated beryllium segments. JWST observes in infrared
wavelengths, allowing it to see through dust clouds and detect light from the earliest
galaxies formed after the Big Bang, over 13 billion years ago.`,
  },
  {
    filename: 'music.txt',
    content: `Jazz originated in New Orleans in the late 19th century, blending African rhythms,
blues, and European harmony. Key innovations include swing rhythm, improvisation over
chord changes, and call-and-response patterns. Miles Davis revolutionized the genre
multiple times — from bebop to cool jazz to fusion. John Coltrane pushed harmonic
boundaries with sheets of sound and modal jazz explorations.`,
  },
];

async function main() {
  header('01 — Basic RAG Retrieval');
  const apiKey = requireEnv('GOOGLE_API_KEY');

  section('1. Initialize RAG pipeline');

  const embeddingAdapter = new InMemoryEmbeddingAdapter();
  const embeddingService = new GoogleEmbeddingService({ apiKey });

  const pipeline = new RAGPipelineBuilder()
    .withLoader(new TextLoader())
    .withEmbeddingService(embeddingService)
    .withEmbeddingAdapter(embeddingAdapter)
    .withConfig({
      chunking: { strategy: 'recursive', chunkSize: 300, chunkOverlap: 50 },
      retrieval: { strategy: 'similarity', topK: 3, threshold: 0.3 },
    })
    .build();

  console.log('Pipeline ready.');

  section('2. Add documents');

  const tempDir = join(tmpdir(), `cogitator-rag-demo-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  for (const doc of DOCUMENTS) {
    await writeFile(join(tempDir, doc.filename), doc.content, 'utf-8');
  }

  const stats = await pipeline.ingest(tempDir);
  console.log(`Ingested ${stats.documents} documents → ${stats.chunks} chunks`);

  await rm(tempDir, { recursive: true, force: true });

  section('3. Query the knowledge base');

  const queries = [
    'How does TypeScript improve JavaScript?',
    'What chemical reactions happen when food is browned?',
    'How far is the James Webb telescope from Earth?',
    'Who were the key innovators in jazz music?',
  ];

  for (const query of queries) {
    console.log(`\nQ: ${query}`);
    const results = await pipeline.query(query);

    if (results.length === 0) {
      console.log('  No results found.');
      continue;
    }

    for (const r of results) {
      const snippet = r.content.replace(/\n/g, ' ').slice(0, 120);
      console.log(`  [${r.score.toFixed(3)}] ${snippet}...`);
    }
  }

  section('4. Pipeline stats');
  const pipelineStats = pipeline.getStats();
  console.log(`Documents ingested: ${pipelineStats.documentsIngested}`);
  console.log(`Chunks stored:      ${pipelineStats.chunksStored}`);
  console.log(`Queries processed:  ${pipelineStats.queriesProcessed}`);

  console.log('\nDone.');
}

main();
