import type { CogitatorConfig, LLMBackend, MemoryAdapter, InsightStore } from '@cogitator-ai/types';
import {
  InMemoryAdapter,
  RedisAdapter,
  PostgresAdapter,
  ContextBuilder,
  type ContextBuilderDeps,
} from '@cogitator-ai/memory';
import { getLogger } from '../logger';
import { ReflectionEngine, InMemoryInsightStore } from '../reflection/index';
import { ConstitutionalAI } from '../constitutional/index';
import { CostAwareRouter } from '../cost-routing/index';
import { PromptInjectionDetector } from '../security/index';
import type { Agent } from '../agent';

export type SandboxManager = {
  initialize(): Promise<void>;
  execute(
    request: { command: string[]; cwd?: string; env?: Record<string, string>; timeout?: number },
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
    };
    error?: string;
  }>;
  isDockerAvailable(): Promise<boolean>;
  shutdown(): Promise<void>;
};

export interface InitializerState {
  memoryAdapter?: MemoryAdapter;
  contextBuilder?: ContextBuilder;
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
}

export async function initializeMemory(
  config: CogitatorConfig,
  state: InitializerState
): Promise<void> {
  if (state.memoryInitialized || !config.memory?.adapter) return;

  const provider = config.memory.adapter;
  let adapter: MemoryAdapter;

  if (provider === 'memory') {
    adapter = new InMemoryAdapter({
      provider: 'memory',
      ...config.memory.inMemory,
    });
  } else if (provider === 'redis') {
    const url = config.memory.redis?.url;
    if (!url) {
      getLogger().warn('Redis adapter requires url in config');
      return;
    }
    adapter = new RedisAdapter({
      provider: 'redis',
      url,
      ...config.memory.redis,
    });
  } else if (provider === 'postgres') {
    const connectionString = config.memory.postgres?.connectionString;
    if (!connectionString) {
      getLogger().warn('Postgres adapter requires connectionString in config');
      return;
    }
    adapter = new PostgresAdapter({
      provider: 'postgres',
      connectionString,
      ...config.memory.postgres,
    });
  } else {
    getLogger().warn(`Unknown memory provider: ${provider}`);
    return;
  }

  const result = await adapter.connect();
  if (!result.success) {
    getLogger().warn('Memory adapter connection failed', { error: result.error });
    return;
  }

  state.memoryAdapter = adapter;

  if (config.memory.contextBuilder) {
    const deps: ContextBuilderDeps = {
      memoryAdapter: state.memoryAdapter,
    };
    const contextConfig = {
      maxTokens: config.memory.contextBuilder.maxTokens ?? 4000,
      strategy: config.memory.contextBuilder.strategy ?? 'recent',
      ...config.memory.contextBuilder,
    } as const;
    state.contextBuilder = new ContextBuilder(contextConfig, deps);
  }

  state.memoryInitialized = true;
}

export async function initializeSandbox(
  config: CogitatorConfig,
  state: InitializerState
): Promise<void> {
  if (state.sandboxInitialized) return;

  try {
    const { SandboxManager } = await import('@cogitator-ai/sandbox');
    state.sandboxManager = new SandboxManager(config.sandbox) as SandboxManager;
    await state.sandboxManager.initialize();
    state.sandboxInitialized = true;
  } catch {
    state.sandboxInitialized = true;
  }
}

export async function initializeReflection(
  config: CogitatorConfig,
  state: InitializerState,
  agent: Agent,
  getBackend: (model: string) => LLMBackend
): Promise<void> {
  if (state.reflectionInitialized || !config.reflection?.enabled) return;

  const backend = getBackend(config.reflection.reflectionModel ?? agent.model);

  state.insightStore = new InMemoryInsightStore();
  state.reflectionEngine = new ReflectionEngine({
    llm: backend,
    insightStore: state.insightStore,
    config: config.reflection,
  });

  state.reflectionInitialized = true;
}

export function initializeGuardrails(
  config: CogitatorConfig,
  state: InitializerState,
  agent: Agent,
  getBackend: (model: string) => LLMBackend
): void {
  if (state.guardrailsInitialized || !config.guardrails?.enabled) return;

  const backend = getBackend(config.guardrails.model ?? agent.model);

  state.constitutionalAI = new ConstitutionalAI({
    llm: backend,
    constitution: config.guardrails.constitution,
    config: config.guardrails,
  });

  state.guardrailsInitialized = true;
}

export function initializeCostRouting(config: CogitatorConfig, state: InitializerState): void {
  if (state.costRoutingInitialized || !config.costRouting?.enabled) return;

  state.costRouter = new CostAwareRouter({ config: config.costRouting });
  state.costRoutingInitialized = true;
}

export function initializeSecurity(
  config: CogitatorConfig,
  state: InitializerState,
  getBackend: (model: string) => LLMBackend
): void {
  if (state.securityInitialized || !config.security?.promptInjection) return;

  const injectionConfig = config.security.promptInjection;

  if (injectionConfig.classifier === 'llm' && !injectionConfig.llmBackend) {
    const model = injectionConfig.llmModel ?? 'gpt-4o-mini';
    injectionConfig.llmBackend = getBackend(model);
  }

  state.injectionDetector = new PromptInjectionDetector(injectionConfig);
  state.securityInitialized = true;
}

export async function cleanupState(state: InitializerState): Promise<void> {
  if (state.memoryAdapter) {
    await state.memoryAdapter.disconnect();
    state.memoryAdapter = undefined;
    state.contextBuilder = undefined;
    state.memoryInitialized = false;
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
}
