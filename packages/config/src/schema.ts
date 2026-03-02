import { z } from 'zod';

export const LLMProviderSchema = z.enum([
  'ollama',
  'openai',
  'anthropic',
  'google',
  'azure',
  'bedrock',
  'vllm',
]);

export const ProvidersConfigSchema = z.object({
  ollama: z.object({ baseUrl: z.string(), apiKey: z.string().optional() }).optional(),
  openai: z.object({ apiKey: z.string(), baseUrl: z.string().optional() }).optional(),
  anthropic: z.object({ apiKey: z.string() }).optional(),
  google: z.object({ apiKey: z.string() }).optional(),
  azure: z
    .object({
      apiKey: z.string(),
      endpoint: z.string(),
      apiVersion: z.string().optional(),
    })
    .optional(),
  bedrock: z
    .object({
      region: z.string(),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
    })
    .optional(),
  vllm: z.object({ baseUrl: z.string() }).optional(),
});

export const LLMConfigSchema = z.object({
  defaultProvider: LLMProviderSchema.optional(),
  defaultModel: z.string().optional(),
  providers: ProvidersConfigSchema.optional(),
});

export const LimitsConfigSchema = z.object({
  maxConcurrentRuns: z.number().positive().optional(),
  defaultTimeout: z.number().positive().optional(),
  maxTokensPerRun: z.number().positive().optional(),
});

export const MemoryProviderSchema = z.enum([
  'memory',
  'redis',
  'postgres',
  'sqlite',
  'mongodb',
  'qdrant',
]);

export const ContextStrategySchema = z.enum(['recent', 'relevant', 'hybrid']);

export const ContextBuilderConfigSchema = z.object({
  maxTokens: z.number().positive().optional(),
  reserveTokens: z.number().positive().optional(),
  strategy: ContextStrategySchema.optional(),
  includeSystemPrompt: z.boolean().optional(),
  includeFacts: z.boolean().optional(),
  includeSemanticContext: z.boolean().optional(),
  includeGraphContext: z.boolean().optional(),
  graphContextOptions: z
    .object({
      maxNodes: z.number().positive().optional(),
      maxDepth: z.number().positive().optional(),
    })
    .optional(),
});

export const EmbeddingConfigSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('openai'),
    apiKey: z.string(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
  }),
  z.object({
    provider: z.literal('ollama'),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
  }),
  z.object({
    provider: z.literal('google'),
    apiKey: z.string(),
    model: z.string().optional(),
  }),
]);

export const MemoryConfigSchema = z.object({
  adapter: MemoryProviderSchema.optional(),
  inMemory: z
    .object({
      maxEntries: z.number().positive().optional(),
    })
    .optional(),
  redis: z
    .object({
      url: z.string().optional(),
      host: z.string().optional(),
      port: z.number().positive().optional(),
      cluster: z
        .object({
          nodes: z.array(z.object({ host: z.string(), port: z.number() })),
          scaleReads: z.enum(['master', 'slave', 'all']).optional(),
        })
        .optional(),
      keyPrefix: z.string().optional(),
      ttl: z.number().positive().optional(),
      password: z.string().optional(),
    })
    .optional(),
  postgres: z
    .object({
      connectionString: z.string(),
      schema: z.string().optional(),
      poolSize: z.number().positive().optional(),
    })
    .optional(),
  sqlite: z
    .object({
      path: z.string(),
      walMode: z.boolean().optional(),
    })
    .optional(),
  mongodb: z
    .object({
      uri: z.string(),
      database: z.string().optional(),
      collectionPrefix: z.string().optional(),
    })
    .optional(),
  qdrant: z
    .object({
      url: z.string().optional(),
      apiKey: z.string().optional(),
      collection: z.string().optional(),
      dimensions: z.number().positive(),
    })
    .optional(),
  embedding: EmbeddingConfigSchema.optional(),
  contextBuilder: ContextBuilderConfigSchema.optional(),
});

export const SandboxTypeSchema = z.enum(['docker', 'native', 'wasm']);

export const SandboxResourcesSchema = z.object({
  memory: z.string().optional(),
  cpuShares: z.number().optional(),
  cpus: z.number().optional(),
  pidsLimit: z.number().positive().optional(),
});

export const SandboxNetworkSchema = z.object({
  mode: z.enum(['none', 'bridge', 'host']).optional(),
  allowedHosts: z.array(z.string()).optional(),
  dns: z.array(z.string()).optional(),
});

export const SandboxDefaultsSchema = z.object({
  type: SandboxTypeSchema.optional(),
  image: z.string().optional(),
  resources: SandboxResourcesSchema.optional(),
  network: SandboxNetworkSchema.optional(),
  timeout: z.number().positive().optional(),
  workdir: z.string().optional(),
  user: z.string().optional(),
});

export const SandboxPoolSchema = z.object({
  maxSize: z.number().positive().optional(),
  idleTimeoutMs: z.number().positive().optional(),
});

export const SandboxDockerSchema = z.object({
  socketPath: z.string().optional(),
  host: z.string().optional(),
  port: z.number().positive().optional(),
});

export const SandboxWasmSchema = z.object({
  wasmModule: z.string().optional(),
  memoryPages: z.number().positive().optional(),
  functionName: z.string().optional(),
  wasi: z.boolean().optional(),
  cacheSize: z.number().positive().optional(),
});

export const SandboxConfigSchema = z.object({
  defaults: SandboxDefaultsSchema.optional(),
  pool: SandboxPoolSchema.optional(),
  docker: SandboxDockerSchema.optional(),
  wasm: SandboxWasmSchema.optional(),
});

export const ReflectionConfigSchema = z.object({
  enabled: z.boolean(),
  reflectAfterToolCall: z.boolean().optional(),
  reflectAfterError: z.boolean().optional(),
  reflectAtEnd: z.boolean().optional(),
  storeInsights: z.boolean().optional(),
  maxInsightsPerAgent: z.number().positive().optional(),
  minConfidenceToStore: z.number().min(0).max(1).optional(),
  useSmallModelForReflection: z.boolean().optional(),
  reflectionModel: z.string().optional(),
});

export const HarmCategorySchema = z.enum([
  'violence',
  'hate',
  'sexual',
  'self-harm',
  'illegal',
  'privacy',
  'misinformation',
  'manipulation',
]);

export const SeveritySchema = z.enum(['low', 'medium', 'high']);

export const GuardrailConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string().optional(),
  filterInput: z.boolean(),
  filterOutput: z.boolean(),
  filterToolCalls: z.boolean(),
  filterToolResults: z.boolean(),
  enableCritiqueRevision: z.boolean(),
  maxRevisionIterations: z.number().positive(),
  revisionConfidenceThreshold: z.number().min(0).max(1),
  thresholds: z.record(HarmCategorySchema, SeveritySchema),
  strictMode: z.boolean(),
  logViolations: z.boolean(),
});

export const BudgetConfigSchema = z.object({
  maxCostPerRun: z.number().positive().optional(),
  maxCostPerHour: z.number().positive().optional(),
  maxCostPerDay: z.number().positive().optional(),
  warningThreshold: z.number().min(0).max(1).optional(),
});

export const CostRoutingConfigSchema = z.object({
  enabled: z.boolean(),
  autoSelectModel: z.boolean().optional(),
  preferLocal: z.boolean().optional(),
  minCapabilityMatch: z.number().min(0).max(1).optional(),
  budget: BudgetConfigSchema.optional(),
  trackCosts: z.boolean().optional(),
  ollamaUrl: z.string().optional(),
});

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);

export const LoggingConfigSchema = z.object({
  level: LogLevelSchema.optional(),
  format: z.enum(['json', 'pretty']).optional(),
  destination: z.enum(['console', 'file']).optional(),
  filePath: z.string().optional(),
});

export const KnowledgeGraphExtractionConfigSchema = z.object({
  enabled: z.boolean(),
  extractOnMessage: z.boolean().optional(),
  extractOnFact: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  batchSize: z.number().positive().optional(),
});

export const KnowledgeGraphInferenceConfigSchema = z.object({
  enabled: z.boolean(),
  autoMaterialize: z.boolean().optional(),
  defaultRules: z.boolean().optional(),
});

export const KnowledgeGraphContextConfigSchema = z.object({
  maxNodes: z.number().positive().optional(),
  maxEdges: z.number().positive().optional(),
  maxDepth: z.number().positive().optional(),
  includeInferred: z.boolean().optional(),
});

export const KnowledgeGraphConfigSchema = z.object({
  extraction: KnowledgeGraphExtractionConfigSchema.optional(),
  inference: KnowledgeGraphInferenceConfigSchema.optional(),
  context: KnowledgeGraphContextConfigSchema.optional(),
});

export const ABTestingConfigSchema = z.object({
  defaultConfidenceLevel: z.number().min(0).max(1).optional(),
  defaultMinSampleSize: z.number().positive().optional(),
  defaultMaxDuration: z.number().positive().optional(),
  autoDeployWinner: z.boolean().optional(),
});

export const MonitoringConfigSchema = z.object({
  windowSize: z.number().positive().optional(),
  scoreDropThreshold: z.number().min(0).max(1).optional(),
  latencySpikeThreshold: z.number().positive().optional(),
  errorRateThreshold: z.number().min(0).max(1).optional(),
  enableAutoRollback: z.boolean().optional(),
  rollbackCooldown: z.number().positive().optional(),
});

export const AutoOptimizationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  triggerAfterRuns: z.number().positive().optional(),
  minRunsForOptimization: z.number().positive().optional(),
  requireABTest: z.boolean().optional(),
  maxOptimizationsPerDay: z.number().positive().optional(),
});

export const PromptOptimizationConfigSchema = z.object({
  enabled: z.boolean(),
  capturePrompts: z.boolean().optional(),
  promptRetentionDays: z.number().positive().optional(),
  abTesting: ABTestingConfigSchema.optional(),
  monitoring: MonitoringConfigSchema.optional(),
  autoOptimization: AutoOptimizationConfigSchema.optional(),
});

export const InjectionActionSchema = z.enum(['block', 'warn', 'log']);
export const InjectionClassifierSchema = z.enum(['local', 'llm']);

export const PromptInjectionConfigSchema = z.object({
  detectInjection: z.boolean(),
  detectJailbreak: z.boolean(),
  detectRoleplay: z.boolean(),
  detectEncoding: z.boolean(),
  detectContextManipulation: z.boolean(),
  classifier: InjectionClassifierSchema,
  llmModel: z.string().optional(),
  action: InjectionActionSchema,
  threshold: z.number().min(0).max(1),
  allowlist: z.array(z.string()).optional(),
});

export const SecurityConfigSchema = z.object({
  promptInjection: PromptInjectionConfigSchema.optional(),
});

export const CompressionStrategySchema = z.enum([
  'truncate',
  'sliding-window',
  'summarize',
  'hybrid',
]);

export const ContextManagerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  strategy: CompressionStrategySchema.optional(),
  compressionThreshold: z.number().positive().optional(),
  outputReserve: z.number().positive().optional(),
  summaryModel: z.string().optional(),
  windowSize: z.number().positive().optional(),
  windowOverlap: z.number().positive().optional(),
});

export const DeployTargetSchema = z.enum(['docker', 'fly', 'railway', 'k8s', 'ssh']);
export const DeployServerSchema = z.enum(['express', 'fastify', 'hono', 'koa']);

export const DeployConfigSchema = z.object({
  target: DeployTargetSchema.optional(),
  server: DeployServerSchema.optional(),
  port: z.number().positive().optional(),
  registry: z.string().optional(),
  image: z.string().optional(),
  region: z.string().optional(),
  instances: z.number().positive().optional(),
  services: z
    .object({
      redis: z.boolean().optional(),
      postgres: z.boolean().optional(),
    })
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string()).optional(),
  health: z
    .object({
      path: z.string().optional(),
      interval: z.string().optional(),
      timeout: z.string().optional(),
    })
    .optional(),
  resources: z
    .object({
      memory: z.string().optional(),
      cpu: z.number().positive().optional(),
    })
    .optional(),
});

export const CogitatorConfigSchema = z.object({
  llm: LLMConfigSchema.optional(),
  limits: LimitsConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  reflection: ReflectionConfigSchema.optional(),
  guardrails: GuardrailConfigSchema.optional(),
  costRouting: CostRoutingConfigSchema.optional(),
  knowledgeGraph: KnowledgeGraphConfigSchema.optional(),
  promptOptimization: PromptOptimizationConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  context: ContextManagerConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  deploy: DeployConfigSchema.optional(),
});

export type CogitatorConfigInput = z.input<typeof CogitatorConfigSchema>;
export type CogitatorConfigOutput = z.output<typeof CogitatorConfigSchema>;
