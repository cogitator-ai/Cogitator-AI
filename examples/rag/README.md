# RAG Examples

Retrieval-augmented generation examples using `@cogitator-ai/rag`.

## Prerequisites

All examples require a Google API key for embeddings:

```bash
export GOOGLE_API_KEY=your-key-here
```

## Examples

### 01 — Basic Retrieval

End-to-end RAG pipeline: ingest documents, query by topic, display scored results.

```bash
npx tsx examples/rag/01-basic-retrieval.ts
```

### 02 — Chunking Strategies

Compare fixed-size, recursive, and semantic chunking on the same document.

```bash
npx tsx examples/rag/02-chunking-strategies.ts
```

### 03 — Agent with RAG Tools

Cogitator agent that searches a knowledge base to answer questions.

```bash
npx tsx examples/rag/03-agent-with-rag.ts
```
