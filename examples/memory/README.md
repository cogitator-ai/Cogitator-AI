# Memory Examples

Persistent memory, token-aware context building, hybrid search, and knowledge graphs.

## Prerequisites

```bash
pnpm install && pnpm build
cp .env.example .env  # add GOOGLE_API_KEY at minimum
```

## Examples

| #   | File                    | LLM needed | Description                                                |
| --- | ----------------------- | ---------- | ---------------------------------------------------------- |
| 01  | `01-basic-memory.ts`    | Yes        | InMemoryAdapter, threads, multi-turn agent conversation    |
| 02  | `02-context-builder.ts` | No         | Token-aware context window management, truncation metadata |
| 03  | `03-semantic-search.ts` | Embeddings | Hybrid BM25 + vector search across a document collection   |
| 04  | `04-knowledge-graph.ts` | Yes        | Entity extraction from text, relations, graph traversal    |

## Running

```bash
npx tsx examples/memory/01-basic-memory.ts
npx tsx examples/memory/02-context-builder.ts
npx tsx examples/memory/03-semantic-search.ts
npx tsx examples/memory/04-knowledge-graph.ts
```
