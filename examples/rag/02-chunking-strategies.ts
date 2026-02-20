import { header, requireEnv, section } from '../_shared/setup.js';
import { FixedSizeChunker, RecursiveChunker, SemanticChunker } from '@cogitator-ai/rag';
import { GoogleEmbeddingService } from '@cogitator-ai/memory';

const SAMPLE_TEXT = `Artificial intelligence has evolved dramatically since its inception in the 1950s. Early AI systems relied on hand-crafted rules and symbolic reasoning, requiring explicit programming for every decision. These expert systems could solve narrow problems but lacked the ability to generalize.

The shift to machine learning in the 1990s changed everything. Instead of programming rules, researchers trained algorithms on data. Support vector machines and random forests could classify and predict with remarkable accuracy. However, feature engineering remained a manual, labor-intensive process.

Deep learning emerged as a breakthrough around 2012, when convolutional neural networks achieved superhuman performance on image recognition tasks. The key ingredients were large datasets, powerful GPUs, and the backpropagation algorithm. Suddenly, models could learn their own features directly from raw data.

The transformer architecture, introduced in 2017 with the paper "Attention Is All You Need," revolutionized natural language processing. Self-attention mechanisms allowed models to capture long-range dependencies in text far better than recurrent neural networks. This led to GPT, BERT, and their successors.

Large language models like GPT-4 and Claude demonstrate emergent abilities that were not explicitly programmed. They can reason, write code, translate languages, and even engage in creative tasks. The scaling hypothesis suggests that increasing model size and training data leads to qualitatively new capabilities.

Retrieval-augmented generation combines the strengths of LLMs with external knowledge bases. Instead of relying solely on parametric memory, RAG systems retrieve relevant documents at inference time. This reduces hallucinations, enables up-to-date information, and provides traceable sources for generated answers.`;

function printChunkStats(chunks: { content: string }[], strategyName: string) {
  const sizes = chunks.map((c) => c.content.length);
  const avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);

  console.log(`Strategy:    ${strategyName}`);
  console.log(`Chunks:      ${chunks.length}`);
  console.log(`Avg size:    ${avgSize} chars`);
  console.log(`Range:       ${minSize}–${maxSize} chars`);
  console.log();

  const preview = chunks.slice(0, 3);
  for (let i = 0; i < preview.length; i++) {
    const text = preview[i].content.replace(/\n/g, ' ').slice(0, 100);
    console.log(`  Chunk ${i + 1}: "${text}..."`);
  }
  if (chunks.length > 3) {
    console.log(`  ... and ${chunks.length - 3} more`);
  }
}

async function main() {
  header('02 — Chunking Strategies Comparison');
  const apiKey = requireEnv('GOOGLE_API_KEY');

  section('1. Sample document');
  console.log(`Length: ${SAMPLE_TEXT.length} chars`);
  console.log(`Paragraphs: ${SAMPLE_TEXT.split('\n\n').length}`);

  section('2. Fixed-size chunking');
  const fixed = new FixedSizeChunker({ chunkSize: 300, chunkOverlap: 50 });
  const fixedChunks = fixed.chunk(SAMPLE_TEXT, 'doc-1');
  printChunkStats(fixedChunks, 'FixedSize (300 chars, 50 overlap)');

  section('3. Recursive chunking');
  const recursive = new RecursiveChunker({ chunkSize: 300, chunkOverlap: 50 });
  const recursiveChunks = recursive.chunk(SAMPLE_TEXT, 'doc-1');
  printChunkStats(recursiveChunks, 'Recursive (300 chars, 50 overlap)');

  section('4. Semantic chunking (requires embeddings)');
  const embeddingService = new GoogleEmbeddingService({ apiKey });
  const semantic = new SemanticChunker({
    embeddingService,
    breakpointThreshold: 0.5,
    minChunkSize: 100,
    maxChunkSize: 600,
  });
  const semanticChunks = await semantic.chunk(SAMPLE_TEXT, 'doc-1');
  printChunkStats(semanticChunks, 'Semantic (threshold 0.5, 100–600 chars)');

  section('5. Summary');
  console.log('Fixed-size splits text at exact character boundaries — fast but may');
  console.log('cut sentences mid-word.\n');
  console.log('Recursive splits on natural boundaries (paragraphs, sentences) first,');
  console.log('then falls back to smaller separators — better coherence.\n');
  console.log('Semantic uses embedding similarity between sentences to find topic');
  console.log('shifts — best coherence, but requires an embedding model.');

  console.log('\nDone.');
}

main();
