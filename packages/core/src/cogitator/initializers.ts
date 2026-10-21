import type { ModelPricing } from '@cogitator-ai/models';
import type {
  CogitatorConfig,
  Constitution,
  EmbeddingAdapter,
  EmbeddingService,
  EmbeddingServiceConfig,
  FactAdapter,
  MemoryAdapter,
  MemoryConfig,
  InsightStore,
  ModelRoute,
} from '@cogitator-ai/types';
import {
  InMemoryAdapter,
  InMemoryEmbeddingAdapter,
  RedisAdapter,
  PostgresAdapter,
  SQLiteAdapter,
  MongoDBAdapter,
  QdrantAdapter,
  ContextBuilder,
  MessageIndex,
  MemoryItems,
  isMemoryItemAdapter,
  createEmbeddingService,
  type ContextBuilderDeps,
} from '@cogitator-ai/memory';
import { getLogger } from '../logger';
import { ReflectionEngine, InMemoryInsightStore } from '../reflection/index';
import { ConstitutionalAI } from '../constitutional/index';
import { CostAwareRouter } from '../cost-routing/index';
import { PromptInjectionDetector } from '../security/index';
import { ContextManager } from '../context/index';

export type SandboxManager = {
  initialize(): Promise<void>;
  execute(
    request: {
      command: string[];
      stdin?: string;
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
      signal?: AbortSignal;
    },
    config: {
      type: string;
      image?: string;
      resources?: unknown;
      network?: unknown;
      timeout?: number;
    }
  ): Promise<{
    success: boolean;
    data?: {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
      duration: number;
      truncated?: boolean;
    };
    error?: string;
  }>;
  isDockerAvailable(): Promise<boolean>;
  shutdown(): Promise<void>;
};

export interface InitializerState {
  memoryAdapter?: MemoryAdapter;
  embeddingStore?: QdrantAdapter;
  contextBuilder?: ContextBuilder;
  messageIndex?: MessageIndex;
  /** Memory items of the memory adapter, when it stores them */
  memoryItems?: MemoryItems;
  memoryInitialized: boolean;
  sandboxManager?: SandboxManager;
  sandboxInitialized: boolean;
  reflectionEngine?: ReflectionEngine;
  insightStore?: InsightStore;
  reflectionInitialized: boolean;
  constitutionalAI?: ConstitutionalAI;
  guardrailsInitialized: boolean;
  costRouter?: CostAwareRouter;
  costRoutingInitialized: boolean;
  injectionDetector?: PromptInjectionDetector;
  securityInitialized: boolean;
  contextManager?: ContextManager;
  contextManagerInitialized: boolean;
}

export async function initializeMemory(
  config: CogitatorConfig,
  state: InitializerState
): Promise<void> {
  const memory = config.memory;
  if (state.memoryInitialized || !memory?.adapter) return;

  const embedding = memory.embedding;
  const embeddingService = !embedding
    ? undefined
    : isEmbeddingService(embedding)
      ? embedding
      : createEmbeddingService(embedding);
  const adapter = createConfiguredAdapter(memory, embeddingService);
  if (!adapter) return;

  const result = await adapter.connect();
  if (!result.success) {
    getLogger().warn('Memory adapter connection failed', { error: result.error });
    await releaseAdapter(adapter);
    return;
  }

  state.memoryAdapter = adapter;

  if (memory.contextBuilder) {
    const embeddingAdapter =
      (await connectEmbeddingStore(memory, embeddingService, state)) ?? embeddingStoreOf(adapter);
    const contextConfig = {
      ...memory.contextBuilder,
      strategy: memory.contextBuilder.strategy ?? 'recent',
      includeSystemPrompt: true,
      ...(memory.contextBuilder.timeZone === undefined &&
        memory.extraction?.timeZone !== undefined && { timeZone: memory.extraction.timeZone }),
    } as const;
    const messageIndex =
      contextConfig.strategy !== 'recent' && embeddingService
        ? indexFor(
            adapter,
            adapter instanceof InMemoryAdapter || !embeddingAdapter
              ? new InMemoryEmbeddingAdapter()
              : embeddingAdapter,
            embeddingService
          )
        : undefined;
    state.messageIndex = messageIndex;
    state.memoryItems = isMemoryItemAdapter(adapter) ? new MemoryItems({ adapter }) : undefined;
    const deps: ContextBuilderDeps = {
      memoryAdapter: adapter,
      ...(isFactAdapter(adapter) && { factAdapter: adapter }),
      ...(state.memoryItems && { memoryItems: state.memoryItems }),
      ...(memory.reranker && { reranker: memory.reranker }),
      ...(embeddingAdapter && { embeddingAdapter }),
      ...(embeddingService && { embeddingService }),
      ...(messageIndex && { messageIndex }),
    };
    warnAboutMissingContextParts(memory.contextBuilder, deps);
    state.contextBuilder = new ContextBuilder(contextConfig, deps);
  } else if (memory.qdrant) {
    getLogger().warn(
      'memory.qdrant is used for semantic retrieval by memory.contextBuilder, which is not configured'
    );
  }

  state.memoryInitialized = true;
}

/**
 * The index keeping a vector per history entry for the `relevant` and `hybrid` strategies, in
 * the embedding store. The in-process `memory` adapter gets none: its entries live as long as the
 * process, and the context builder keeps their vectors in process too, while a store outside
 * would keep vectors of entries a restart forgot. Background failures are logged, as no run
 * waits on them.
 */
/**
 * The index that embeds each entry of `adapter` once, its vectors in `store`: the configured
 * embedding store, or one in process for a memory with none or one in process itself (whose
 * entries would leave vectors behind in a lasting store), so `relevant` and `hybrid` search a
 * whole thread instead of its newest entries on every memory
 */
function indexFor(
  adapter: MemoryAdapter,
  store: EmbeddingAdapter,
  embedding: EmbeddingService
): MessageIndex {
  const logger = getLogger();
  const index = new MessageIndex({
    store,
    embedding,
    onError: (error) =>
      logger.warn('Indexing memory entries failed', { operation: 'index', error: error.message }),
  });
  if (!index.attach(adapter)) {
    logger.warn(
      `The ${adapter.provider} memory adapter does not report its changes (onChange): its ` +
        'entries are embedded only when a context needs them, and the vectors of deleted ' +
        'entries stay in the embedding store'
    );
  }
  if (!store.deleteByFilter) {
    logger.warn(
      'The embedding store has no deleteByFilter: vectors of cleared and deleted threads stay in it'
    );
  }
  return index;
}

/**
 * Warns about `memory.contextBuilder` options that would silently add
 * nothing: the runtime always sends the agent's instructions, facts need a
 * fact store, semantic context needs an embedding model and store, and the
 * runtime builds no knowledge graph.
 */
function warnAboutMissingContextParts(
  options: NonNullable<MemoryConfig['contextBuilder']>,
  deps: ContextBuilderDeps
): void {
  const logger = getLogger();
  if (options.includeSystemPrompt === false) {
    logger.warn(
      'memory.contextBuilder.includeSystemPrompt: false is ignored: runs always send the ' +
        "agent's instructions and count them in the context budget"
    );
  }
  if (options.includeFacts && !deps.factAdapter && !deps.memoryItems) {
    logger.warn(
      'memory.contextBuilder.includeFacts adds nothing: memory.adapter ' +
        `'${deps.memoryAdapter.provider}' stores neither facts nor memory items`
    );
  }
  if (options.includeSemanticContext && (!deps.embeddingService || !deps.embeddingAdapter)) {
    logger.warn(
      'memory.contextBuilder.includeSemanticContext adds nothing: it needs memory.embedding ' +
        'and an embedding store (the postgres adapter with pgvector, or memory.qdrant)',
      { embedding: !!deps.embeddingService, store: !!deps.embeddingAdapter }
    );
  }
  if (options.includeGraphContext) {
    logger.warn(
      'memory.contextBuilder.includeGraphContext adds nothing: the runtime does not build a ' +
        'knowledge graph. Use ContextBuilder from @cogitator-ai/memory with a graphContextBuilder'
    );
  }
}

/**
 * The thread store `memory.adapter` names, built from its section of the
 * config; undefined, with a warning, when that section lacks what the store
 * needs. A Postgres store gets the vector size of `memory.embedding`.
 */
function createConfiguredAdapter(
  memory: MemoryConfig,
  embeddingService: EmbeddingService | undefined
): MemoryAdapter | undefined {
  const logger = getLogger();
  switch (memory.adapter) {
    case 'memory':
      return new InMemoryAdapter({ provider: 'memory', ...memory.inMemory });

    case 'redis': {
      const redis = memory.redis;
      if (!redis?.url && !redis?.host && !redis?.cluster) {
        logger.warn('Redis adapter requires url, host or cluster in memory.redis');
        return undefined;
      }
      return new RedisAdapter({ provider: 'redis', ...redis });
    }

    case 'postgres': {
      const postgres = memory.postgres;
      if (!postgres?.connectionString) {
        logger.warn('Postgres adapter requires connectionString in memory.postgres');
        return undefined;
      }
      const adapter = new PostgresAdapter({ provider: 'postgres', ...postgres });
      if (embeddingService) {
        if (
          postgres.dimensions !== undefined &&
          postgres.dimensions !== embeddingService.dimensions
        ) {
          logger.warn('memory.postgres.dimensions does not match the embedding model', {
            postgres: postgres.dimensions,
            embedding: embeddingService.dimensions,
            model: embeddingService.model,
          });
        }
        adapter.setVectorDimensions(embeddingService.dimensions);
      }
      return adapter;
    }

    case 'sqlite': {
      const sqlite = memory.sqlite;
      if (!sqlite?.path) {
        logger.warn('SQLite adapter requires path in memory.sqlite');
        return undefined;
      }
      return new SQLiteAdapter({ provider: 'sqlite', ...sqlite });
    }

    case 'mongodb': {
      const mongodb = memory.mongodb;
      if (!mongodb?.uri) {
        logger.warn('MongoDB adapter requires uri in memory.mongodb');
        return undefined;
      }
      return new MongoDBAdapter({ provider: 'mongodb', ...mongodb });
    }

    case 'qdrant':
      logger.warn(
        'Qdrant stores embeddings, not threads: set memory.adapter to memory, redis, postgres, ' +
          'sqlite or mongodb, and keep memory.qdrant for semantic retrieval by memory.contextBuilder'
      );
      return undefined;

    default:
      logger.warn(`Unknown memory provider: ${String(memory.adapter)}`);
      return undefined;
  }
}

/** Connects `memory.qdrant` as the store semantic retrieval searches, when configured. */
async function connectEmbeddingStore(
  memory: MemoryConfig,
  embeddingService: EmbeddingService | undefined,
  state: InitializerState
): Promise<EmbeddingAdapter | undefined> {
  const qdrant = memory.qdrant;
  if (!qdrant) return undefined;

  if (embeddingService && embeddingService.dimensions !== qdrant.dimensions) {
    getLogger().warn('memory.qdrant.dimensions does not match the embedding model', {
      qdrant: qdrant.dimensions,
      embedding: embeddingService.dimensions,
      model: embeddingService.model,
    });
  }

  const store = new QdrantAdapter({ provider: 'qdrant', ...qdrant });
  const result = await store.connect();
  if (!result.success) {
    getLogger().warn('Qdrant connection failed; semantic retrieval is off', {
      error: result.error,
    });
    await releaseAdapter(store);
    return undefined;
  }
  state.embeddingStore = store;
  return store;
}

export async function initializeSandbox(
  config: CogitatorConfig,
  state: InitializerState
): Promise<SandboxManager | undefined> {
  if (state.sandboxInitialized) return state.sandboxManager;

  try {
    const { SandboxManager } = await import('@cogitator-ai/sandbox');
    const manager = new SandboxManager(config.sandbox) as SandboxManager;
    await manager.initialize();
    state.sandboxManager = manager;
    state.sandboxInitialized = true;
    return manager;
  } catch (err) {
    getLogger().warn('Sandbox initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    state.sandboxManager = undefined;
    state.sandboxInitialized = false;
    return undefined;
  }
}

export async function initializeReflection(
  config: CogitatorConfig,
  state: InitializerState,
  agentModel: string,
  route: (model: string) => ModelRoute
): Promise<void> {
  if (state.reflectionInitialized || !config.reflection?.enabled) return;

  const { backend, model } = route(config.reflection.reflectionModel ?? agentModel);

  state.insightStore = new InMemoryInsightStore();
  state.reflectionEngine = new ReflectionEngine({
    llm: backend,
    insightStore: state.insightStore,
    config: { ...config.reflection, reflectionModel: model },
  });

  state.reflectionInitialized = true;
}

export function initializeGuardrails(
  config: CogitatorConfig,
  state: InitializerState,
  agentModel: string,
  route: (model: string) => ModelRoute,
  constitution?: Constitution
): void {
  if (state.guardrailsInitialized) return;
  if (!config.guardrails || config.guardrails.enabled === false) {
    state.guardrailsInitialized = true;
    return;
  }

  const { backend, model } = route(config.guardrails.model ?? agentModel);

  state.constitutionalAI = new ConstitutionalAI({
    llm: backend,
    constitution: constitution ?? config.guardrails.constitution,
    config: { ...config.guardrails, model },
  });

  state.guardrailsInitialized = true;
}

export function initializeCostRouting(
  config: CogitatorConfig,
  state: InitializerState,
  pricing?: (model: string) => ModelPricing | null
): void {
  if (state.costRoutingInitialized || !config.costRouting?.enabled) return;

  state.costRouter = new CostAwareRouter({ config: config.costRouting, pricing });
  state.costRoutingInitialized = true;
}

export function initializeSecurity(
  config: CogitatorConfig,
  state: InitializerState,
  agentModel: string,
  route: (model: string) => ModelRoute
): void {
  if (state.securityInitialized || !config.security?.promptInjection) return;

  const injectionConfig = { ...config.security.promptInjection };

  if (injectionConfig.classifier === 'llm' && !injectionConfig.llmBackend) {
    const { backend, model } = route(injectionConfig.llmModel ?? agentModel);
    injectionConfig.llmBackend = backend;
    injectionConfig.llmModel = model;
  }

  state.injectionDetector = new PromptInjectionDetector(injectionConfig);
  state.securityInitialized = true;
}

export function initializeContextManager(
  config: CogitatorConfig,
  state: InitializerState,
  route: (model: string) => ModelRoute
): void {
  if (state.contextManagerInitialized) return;
  if (!config.context || config.context.enabled === false) {
    state.contextManagerInitialized = true;
    return;
  }

  state.contextManager = new ContextManager(config.context, { route });
  state.contextManagerInitialized = true;
}

export async function cleanupState(state: InitializerState): Promise<void> {
  if (state.messageIndex) {
    await state.messageIndex.close();
    state.messageIndex = undefined;
  }
  state.memoryItems = undefined;
  if (state.memoryAdapter) {
    await state.memoryAdapter.disconnect();
    state.memoryAdapter = undefined;
    state.contextBuilder = undefined;
    state.memoryInitialized = false;
  }
  if (state.embeddingStore) {
    await state.embeddingStore.disconnect();
    state.embeddingStore = undefined;
  }
  if (state.sandboxManager) {
    await state.sandboxManager.shutdown();
    state.sandboxManager = undefined;
    state.sandboxInitialized = false;
  }
  state.reflectionEngine = undefined;
  state.insightStore = undefined;
  state.reflectionInitialized = false;
  state.constitutionalAI = undefined;
  state.guardrailsInitialized = false;
  state.costRouter = undefined;
  state.costRoutingInitialized = false;
  state.injectionDetector = undefined;
  state.securityInitialized = false;
  state.contextManager = undefined;
  state.contextManagerInitialized = false;
}

function isFactAdapter(adapter: MemoryAdapter): adapter is MemoryAdapter & FactAdapter {
  const candidate = adapter as Partial<FactAdapter>;
  return typeof candidate.getFacts === 'function' && typeof candidate.addFact === 'function';
}

/**
 * The thread store as the store semantic context searches, when it is one: a
 * Postgres store only when pgvector is usable (its reason is logged otherwise).
 */
function embeddingStoreOf(adapter: MemoryAdapter): EmbeddingAdapter | undefined {
  if (!isEmbeddingAdapter(adapter)) return undefined;
  if (adapter instanceof PostgresAdapter) {
    const status = adapter.vectorStatus();
    if (!status.available) {
      getLogger().warn(`Postgres memory has no semantic search: ${status.reason}`);
      return undefined;
    }
  }
  return adapter;
}

/** Closes what a failed `connect()` may have left open, such as a reconnecting client. */
async function releaseAdapter(adapter: { disconnect(): Promise<unknown> }): Promise<void> {
  try {
    await adapter.disconnect();
  } catch (err) {
    getLogger().warn('Could not release a memory adapter that failed to connect', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isEmbeddingAdapter(adapter: MemoryAdapter): adapter is MemoryAdapter & EmbeddingAdapter {
  const candidate = adapter as Partial<EmbeddingAdapter>;
  return typeof candidate.search === 'function' && typeof candidate.addEmbedding === 'function';
}

/** Whether `embedding` is a service of your own rather than a provider's config. */
function isEmbeddingService(
  embedding: EmbeddingServiceConfig | EmbeddingService
): embedding is EmbeddingService {
  return typeof (embedding as Partial<EmbeddingService>).embed === 'function';
}
