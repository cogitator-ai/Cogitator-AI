import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { providerInfo } from '../providers.js';
import { hasFeature, type ProjectSpec } from '../spec.js';
import { cogitatorVersion, IMAGES, VERSIONS } from '../versions.js';
import { addPostgresService, DEFAULT_DATABASE_URL } from './memory.js';
import type { FeatureModule } from './types.js';

const DEFAULT_QDRANT_URL = 'http://localhost:6333';

const HANDBOOK_MD = code`
  # Team handbook

  This file is a sample knowledge base. Replace it with your own Markdown: everything under \`docs/\` is indexed, and the assistant answers from it with \`rag_search\`.

  ## Deploys

  We deploy on Tuesdays and Thursdays between 10:00 and 15:00 Berlin time. No deploys on Fridays or before a public holiday. Every deploy needs a green CI run and one approving review.

  ## On-call

  On-call rotates weekly on Monday at 09:00. The person on call answers pages within 15 minutes and writes an incident note for every page within one working day.

  ## Expenses

  Hardware up to 500 EUR needs no approval. Anything above that needs a manager's approval in the expenses tool before you buy it.
`;

function embeddingService(spec: ProjectSpec): { importName: string; expression: string } {
  switch (spec.provider) {
    case 'openai':
      return {
        importName: 'OpenAIEmbeddingService',
        expression: "new OpenAIEmbeddingService({ apiKey: process.env.OPENAI_API_KEY ?? '' })",
      };
    case 'google':
      return {
        importName: 'GoogleEmbeddingService',
        expression:
          "new GoogleEmbeddingService({ apiKey: process.env.GOOGLE_API_KEY ?? '', dimensions: 768 })",
      };
    case 'ollama':
      return {
        importName: 'OllamaEmbeddingService',
        expression: `new OllamaEmbeddingService({ baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434', model: '${providerInfo('ollama').embeddingModel}' })`,
      };
    case 'anthropic':
      throw new Error(
        'RAG needs an embedding provider, which compatibilityIssues rules out for Anthropic'
      );
  }
}

function storeCode(spec: ProjectSpec): { imports: string[]; body: string } {
  switch (spec.vectorStore) {
    case 'memory':
      return {
        imports: ['InMemoryEmbeddingAdapter'],
        body: code`
          /** Vectors in the process: the docs are indexed again on every start. */
          export function createStore(): EmbeddingAdapter {
            return new InMemoryEmbeddingAdapter();
          }
        `,
      };
    case 'postgres':
      return {
        imports: ['PostgresAdapter'],
        body: code`
          /** Vectors in Postgres with pgvector, kept across restarts. */
          export function createStore(embeddings: EmbeddingService): EmbeddingAdapter {
            return lazilyConnected(
              new PostgresAdapter({
                provider: 'postgres',
                connectionString: process.env.DATABASE_URL ?? '${DEFAULT_DATABASE_URL}',
                dimensions: embeddings.dimensions,
              })
            );
          }
        `,
      };
    case 'qdrant':
      return {
        imports: ['QdrantAdapter'],
        body: code`
          /** Vectors in Qdrant, kept across restarts. */
          export function createStore(embeddings: EmbeddingService): EmbeddingAdapter {
            return lazilyConnected(
              new QdrantAdapter({
                provider: 'qdrant',
                url: process.env.QDRANT_URL ?? '${DEFAULT_QDRANT_URL}',
                collection: 'docs',
                dimensions: embeddings.dimensions,
              })
            );
          }
        `,
      };
  }
}

const LAZY_CONNECT = code`
  /** Connects a store on first use, so importing the project opens no connection. */
  function lazilyConnected(
    store: EmbeddingAdapter & { connect(): Promise<MemoryResult<void>> }
  ): EmbeddingAdapter {
    let connected: Promise<void> | undefined;
    const ready = () =>
      (connected ??= store.connect().then((result) => {
        if (!result.success) throw new Error(\`Cannot connect the vector store: \${result.error}\`);
      }));
    return {
      async addEmbedding(embedding) {
        await ready();
        return store.addEmbedding(embedding);
      },
      async search(options) {
        await ready();
        return store.search(options);
      },
      async deleteEmbedding(id) {
        await ready();
        return store.deleteEmbedding(id);
      },
      async deleteBySource(source) {
        await ready();
        return store.deleteBySource(source);
      },
      async deleteByFilter(filter) {
        await ready();
        if (!store.deleteByFilter) throw new Error('The vector store cannot delete by filter');
        return store.deleteByFilter(filter);
      },
    };
  }
`;

function knowledgeBaseTs(spec: ProjectSpec): string {
  const embedding = embeddingService(spec);
  const store = storeCode(spec);
  const persistent = spec.vectorStore !== 'memory';
  const memoryImports = [...store.imports, embedding.importName].sort();
  return code`
    import { tool } from '@cogitator-ai/core';
    import {
      ${memoryImports.join(',\n')},
      type EmbeddingAdapter,
      type EmbeddingService,
      ${persistent && 'type MemoryResult,'}
    } from '@cogitator-ai/memory';
    import { MarkdownLoader, RAGPipelineBuilder, ragTools } from '@cogitator-ai/rag';

    /** The folder the knowledge base indexes: ./docs, or DOCS_DIR. */
    export const DOCS_DIR = process.env.DOCS_DIR ?? 'docs';

    /** Turns text into vectors with the project's provider. */
    export function createEmbeddings(): EmbeddingService {
      return ${embedding.expression};
    }

    ${persistent && LAZY_CONNECT}

    ${store.body}

    /**
     * Markdown under \`DOCS_DIR\`, split into overlapping chunks and searched by
     * similarity. Ingesting a source again replaces its chunks, so re-indexing
     * after an edit never duplicates anything.
     */
    export function createKnowledgeBase(embeddings: EmbeddingService = createEmbeddings(), store: EmbeddingAdapter = createStore(${persistent ? 'embeddings' : ''})) {
      return new RAGPipelineBuilder()
        .withLoader(new MarkdownLoader())
        .withEmbeddingService(embeddings)
        .withEmbeddingAdapter(store)
        .withConfig({
          chunking: { strategy: 'recursive', chunkSize: 600, chunkOverlap: 80 },
          retrieval: { strategy: 'similarity', topK: 4, threshold: 0.2 },
        })
        .build();
    }

    export const knowledgeBase = createKnowledgeBase();

    const [search] = ragTools(knowledgeBase, { allowedRoots: [DOCS_DIR], allowUrls: false });

    /** rag_search: the assistant looks things up in the docs before it answers. */
    export const ragSearch = tool(search);
  `;
}

const INGEST_TS = code`
  import { DOCS_DIR, knowledgeBase } from './knowledge-base.js';

  /** Indexes DOCS_DIR into the vector store. Safe to run again: changed files replace their old chunks. */
  async function main(): Promise<void> {
    const { documents, chunks } = await knowledgeBase.ingest(DOCS_DIR);
    console.log(\`Indexed \${documents} document(s) in \${chunks} chunk(s) from \${DOCS_DIR}\`);
  }

  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
`;

const RAG_TEST_TS = code`
  import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { InMemoryEmbeddingAdapter, type EmbeddingService } from '@cogitator-ai/memory';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createKnowledgeBase } from '../src/rag/knowledge-base.js';

  /** Bag-of-words vectors: the same words give similar vectors, with no model and no network. */
  const embeddings: EmbeddingService = {
    model: 'test',
    dimensions: 64,
    async embed(text) {
      const vector = new Array<number>(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 64;
        vector[hash] += 1;
      }
      return vector;
    },
    async embedBatch(texts) {
      return Promise.all(texts.map((text) => this.embed(text)));
    },
  };

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-'));
    writeFileSync(join(dir, 'deploys.md'), '# Deploys\\n\\nWe deploy on Tuesdays and Thursdays only.');
    writeFileSync(join(dir, 'lunch.md'), '# Lunch\\n\\nThe kitchen serves soup every Wednesday.');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('knowledge base', () => {
    it('finds the document that answers the question', async () => {
      const kb = createKnowledgeBase(embeddings, new InMemoryEmbeddingAdapter());
      await kb.ingest(dir);

      const [best] = await kb.query('Which days do we deploy?');
      expect(best?.source).toContain('deploys.md');
    });

    it('replaces a document on re-ingest instead of duplicating it', async () => {
      const kb = createKnowledgeBase(embeddings, new InMemoryEmbeddingAdapter());
      await kb.ingest(dir);
      writeFileSync(join(dir, 'deploys.md'), '# Deploys\\n\\nDeploys happen on Mondays now.');
      await kb.ingest(dir);

      const results = await kb.query('deploy days', { topK: 10, threshold: 0 });
      const deploys = results.filter((r) => r.source?.includes('deploys.md'));
      expect(deploys).toHaveLength(1);
      expect(deploys[0]?.content).toContain('Mondays');
    });
  });
`;

/** Answers grounded in the Markdown of docs/: a RAG pipeline and a search tool for the assistant. */
export const ragFeature: FeatureModule = {
  id: 'feature:rag',
  applies: (spec) => hasFeature(spec, 'rag'),
  apply(project) {
    const { spec } = project;
    project
      .dependency('@cogitator-ai/rag', cogitatorVersion('@cogitator-ai/rag'))
      .dependency('@cogitator-ai/memory', cogitatorVersion('@cogitator-ai/memory'))
      .file('docs/handbook.md', HANDBOOK_MD)
      .file('src/rag/knowledge-base.ts', knowledgeBaseTs(spec))
      .file('src/rag/ingest.ts', INGEST_TS)
      .file('tests/rag.test.ts', RAG_TEST_TS)
      .tool('ragSearch', '../rag/knowledge-base.js')
      .instruct(
        'Before you answer a question about the project, its team or its rules, search the docs with rag_search and answer from what it finds. Say so when the docs do not cover it.'
      )
      .envVar({
        name: 'DOCS_DIR',
        description: 'The folder of Markdown the knowledge base indexes',
        example: 'docs',
        required: false,
        secret: false,
      });

    if (
      spec.app === 'script' ||
      spec.app === 'server' ||
      spec.app === 'channels' ||
      spec.app === 'worker'
    ) {
      project.script('ingest', 'tsx --env-file-if-exists=.env src/rag/ingest.ts');
    }

    if (spec.vectorStore === 'postgres') {
      addPostgresService(project);
    } else if (spec.vectorStore === 'qdrant') {
      project
        .dependency('@qdrant/js-client-rest', VERSIONS.qdrant)
        .service(
          {
            name: 'qdrant',
            image: IMAGES.qdrant,
            ports: ['6333:6333'],
            volumes: ['qdrant_data:/qdrant/storage'],
          },
          'qdrant_data'
        )
        .envVar({
          name: 'QDRANT_URL',
          description: 'The Qdrant server',
          example: DEFAULT_QDRANT_URL,
          required: false,
          secret: false,
        });
    } else {
      project.onStartup(
        "import { DOCS_DIR, knowledgeBase } from './rag/knowledge-base.js';",
        'await knowledgeBase.ingest(DOCS_DIR);'
      );
    }
    if (spec.vectorStore !== 'memory') {
      project.step({
        command: runScript(spec.packageManager, 'ingest'),
        note: 'index docs/ once, and again after edits',
      });
    }
  },
  finalize(project) {
    const { spec } = project;
    const pm = spec.packageManager;
    project.section(
      'RAG',
      code`
        \`src/rag/knowledge-base.ts\` indexes the Markdown under \`docs/\` with \`@cogitator-ai/rag\`: chunks are embedded with ${providerInfo(spec.provider).label} and stored ${spec.vectorStore === 'memory' ? 'in memory, so the project indexes them again on every start' : spec.vectorStore === 'postgres' ? 'in Postgres with pgvector' : 'in Qdrant'}. The assistant searches them with \`rag_search\`. ${spec.vectorStore === 'memory' ? '' : `\`${runScript(pm, 'ingest')}\` indexes the folder; re-running it after an edit replaces the changed files' chunks. `}\`tests/rag.test.ts\` runs the pipeline offline with deterministic bag-of-words embeddings.
      `
    );
  },
};
