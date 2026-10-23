import { z } from 'zod';

export const OLLAMA_LOCAL_URL = 'http://localhost:11434';
export const OLLAMA_CLOUD_URL = 'https://ollama.com';

export const LLMProviderSchema = z.enum([
  'ollama',
  'openai',
  'anthropic',
  'google',
  'azure',
  'bedrock',
  'vllm',
  'mistral',
  'groq',
  'together',
  'deepseek',
  'openrouter',
]);

const ProviderHeadersSchema = z.record(
  z.string(),
  z.string().refine((value) => !/[\r\n]/.test(value), {
    message: 'A header value cannot contain a line break',
  })
);

export const OpenAICompatibleServerSchema = z.enum([
  'openai',
  'generic',
  'vllm',
  'ollama',
  'lmstudio',
  'llamacpp',
  'groq',
  'together',
  'deepseek',
  'mistral',
  'openrouter',
]);

const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const OpenAICompatibleProfileSchema = z.union([
  OpenAICompatibleServerSchema,
  z.object({
    server: OpenAICompatibleServerSchema.optional(),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    streamUsage: z.boolean().optional(),
    reasoningEffort: z.union([z.boolean(), z.array(ReasoningEffortSchema)]).optional(),
  }),
]);

export const ProvidersConfigSchema = z.object({
  ollama: z
    .object({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      headers: ProviderHeadersSchema.optional(),
    })
    .transform(({ baseUrl, apiKey, headers }) => ({
      baseUrl: baseUrl ?? (apiKey ? OLLAMA_CLOUD_URL : OLLAMA_LOCAL_URL),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    }))
    .optional(),
  openai: z
    .object({
      apiKey: z.string(),
      baseUrl: z.string().optional(),
      api: z.enum(['responses', 'chat-completions']).optional(),
      profile: OpenAICompatibleProfileSchema.optional(),
      headers: ProviderHeadersSchema.optional(),
    })
    .optional(),
  anthropic: z
    .object({
      apiKey: z.string(),
      baseUrl: z.string().optional(),
      headers: ProviderHeadersSchema.optional(),
    })
    .optional(),
  google: z
    .object({
      apiKey: z.string(),
      baseUrl: z.string().optional(),
      headers: ProviderHeadersSchema.optional(),
    })
    .optional(),
  azure: z
    .object({
      apiKey: z.string(),
      endpoint: z.string(),
      apiVersion: z.string().optional(),
      deployment: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  bedrock: z
    .object({
      region: z.string().optional(),
      accessKeyId: z.string().optional(),
      secretAccessKey: z.string().optional(),
      sessionToken: z.string().optional(),
      profile: z.string().optional(),
      endpoint: z.string().optional(),
    })
    .optional(),
  vllm: z
    .object({
      baseUrl: z.string(),
      profile: OpenAICompatibleProfileSchema.optional(),
      headers: ProviderHeadersSchema.optional(),
    })
    .optional(),
  mistral: z.object({ apiKey: z.string() }).optional(),
  groq: z.object({ apiKey: z.string() }).optional(),
  together: z.object({ apiKey: z.string() }).optional(),
  deepseek: z.object({ apiKey: z.string() }).optional(),
  openrouter: z
    .object({
      apiKey: z.string(),
      baseUrl: z.string().optional(),
      headers: ProviderHeadersSchema.optional(),
    })
    .optional(),
});

export const LLMRetryConfigSchema = z.union([
  z.literal(false),
  z.object({
    maxRetries: z.number().int().nonnegative().optional(),
    baseDelay: z.number().nonnegative().optional(),
    maxDelay: z.number().nonnegative().optional(),
    maxRetryAfter: z.number().nonnegative().optional(),
    requestTimeout: z.number().positive().optional(),
  }),
]);

export const ModelCircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().optional(),
  resetTimeout: z.number().nonnegative().optional(),
  halfOpenRequests: z.number().int().positive().optional(),
});

const PriceSchema = z.number().nonnegative();

export const ModelPriceSchema = z.object({
  input: PriceSchema,
  output: PriceSchema,
  inputCached: PriceSchema.optional(),
  inputCacheWrite: PriceSchema.optional(),
  inputCacheWrite1h: PriceSchema.optional(),
});

export const LLMConfigSchema = z.object({
  defaultProvider: LLMProviderSchema.optional(),
  defaultModel: z.string().optional(),
  providers: ProvidersConfigSchema.optional(),
  retry: LLMRetryConfigSchema.optional(),
  pricing: z.record(z.string(), ModelPriceSchema).optional(),
  promptCache: z
    .union([
      z.literal(false),
      z.object({ ttl: z.enum(['5m', '1h']).optional(), conversation: z.boolean().optional() }),
    ])
    .optional(),
  modelCircuitBreaker: ModelCircuitBreakerConfigSchema.optional(),
  plugins: z.record(z.string(), z.unknown()).optional(),
});

export const LimitsConfigSchema = z.object({
  maxConcurrentRuns: z.number().int().positive().optional(),
  defaultTimeout: z.number().positive().optional(),
  maxTokensPerRun: z.number().int().positive().optional(),
  maxToolResultLength: z.number().int().positive().optional(),
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

export const EntityTypeSchema = z.enum([
  'person',
  'organization',
  'location',
  'concept',
  'event',
  'object',
  'custom',
]);

const TimeZoneSchema = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'an IANA time zone, such as Europe/Lisbon' }
);

export const ContextBuilderConfigSchema = z.object({
  maxTokens: z.number().positive().optional(),
  reserveTokens: z.number().positive().optional(),
  strategy: ContextStrategySchema.optional(),
  includeSystemPrompt: z.boolean().optional(),
  includeFacts: z.boolean().optional(),
  includeSemanticContext: z.boolean().optional(),
  includeGraphContext: z.boolean().optional(),
  timeZone: TimeZoneSchema.optional(),
  graphContextOptions: z
    .object({
      maxNodes: z.number().positive().optional(),
      maxEdges: z.number().positive().optional(),
      maxDepth: z.number().positive().optional(),
      includeInferred: z.boolean().optional(),
      entityTypes: z.array(EntityTypeSchema).optional(),
    })
    .optional(),
  partitions: z
    .partialRecord(
      z.enum([
        'system',
        'pinned',
        'index',
        'summaries',
        'facts',
        'recall',
        'brief',
        'recent',
        'final',
      ]),
      z.object({ share: z.number().min(0).max(1).optional(), required: z.boolean().optional() })
    )
    .optional(),
});

const EmbeddingDimensionsSchema = z.number().int().positive();

export const EmbeddingConfigSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('openai'),
    apiKey: z.string(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    dimensions: EmbeddingDimensionsSchema.optional(),
  }),
  z.object({
    provider: z.literal('ollama'),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    dimensions: EmbeddingDimensionsSchema.optional(),
  }),
  z.object({
    provider: z.literal('google'),
    apiKey: z.string(),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    dimensions: EmbeddingDimensionsSchema.optional(),
  }),
]);

/**
 * `memory.compaction`: compaction of a run's thread after the run. The `beforeCompact` and
 * `afterCompact` hooks are functions, so they are set in code, not in YAML.
 */
export const MemoryCompactionConfigSchema = z.object({
  at: z.number().gt(0).max(1).optional(),
  keepRecent: z.number().int().nonnegative().optional(),
  keepRecentTokens: z.number().int().nonnegative().optional(),
  chapterTokens: z.number().int().positive().optional(),
  chapterConcurrency: z.number().int().positive().optional(),
  chaptersPerArc: z.number().int().positive().optional(),
  arcsPerSaga: z.number().int().positive().optional(),
  summaryModel: z.string().min(1).optional(),
  summaryPrompt: z.string().optional(),
});

/**
 * `memory.extraction`: memory items extracted from a run's conversation after the run. The
 * `afterExtract` hook is a function, so it is set in code, not in YAML.
 */
export const MemoryExtractionConfigSchema = z.object({
  model: z.string().min(1).optional(),
  prompt: z.string().optional(),
  windowTokens: z.number().int().positive().optional(),
  activationConfidence: z.number().min(0).max(1).optional(),
  mode: z.enum(['apply', 'shadow']).optional(),
  scope: z.enum(['user', 'agent', 'thread']).optional(),
  timeZone: TimeZoneSchema.optional(),
});

export const MemoryFilesConfigSchema = z.object({
  scope: z.enum(['user', 'agent', 'thread']).optional(),
  readOnly: z.boolean().optional(),
  indexChars: z.number().int().positive().optional(),
});

export const MemoryBriefConfigSchema = z.object({
  model: z.string().min(1).optional(),
  maxCards: z.number().int().min(1).max(4).optional(),
  timeoutMs: z.number().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  prompt: z.string().optional(),
});

export const MemoryObservationsConfigSchema = z.object({
  model: z.string().min(1).optional(),
  maxEntities: z.number().int().positive().optional(),
  minItems: z.number().int().positive().optional(),
  prompt: z.string().optional(),
});

/**
 * `memory.consolidation` as config files set it: its `afterConsolidate` hook is a function, so
 * it is set in code, not in YAML.
 */
export const MemoryConsolidationConfigSchema = z.object({
  model: z.string().min(1).optional(),
  everyRuns: z.number().int().positive().optional(),
  afterCompaction: z.boolean().optional(),
  maxChanges: z.number().int().min(0).optional(),
  maxSubjects: z.number().int().positive().optional(),
  playbook: z.union([z.enum(['apply', 'shadow']), z.literal(false)]).optional(),
  showPlaybook: z.boolean().optional(),
  prompt: z.string().optional(),
});

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
      dimensions: z.number().int().positive().optional(),
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
  compaction: MemoryCompactionConfigSchema.optional(),
  extraction: MemoryExtractionConfigSchema.optional(),
  files: MemoryFilesConfigSchema.optional(),
  brief: MemoryBriefConfigSchema.optional(),
  observations: MemoryObservationsConfigSchema.optional(),
  consolidation: MemoryConsolidationConfigSchema.optional(),
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

export const SandboxMountSchema = z.object({
  source: z.string(),
  target: z.string(),
  readOnly: z.boolean().optional(),
});

export const SandboxDefaultsSchema = z.object({
  type: SandboxTypeSchema.optional(),
  image: z.string().optional(),
  resources: SandboxResourcesSchema.optional(),
  network: SandboxNetworkSchema.optional(),
  mounts: z.array(SandboxMountSchema).optional(),
  timeout: z.number().positive().optional(),
  workdir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  user: z.string().optional(),
  wasmModule: z.string().optional(),
  wasmFunction: z.string().optional(),
  wasi: z.boolean().optional(),
});

export const SandboxPoolSchema = z.object({
  maxSize: z.number().positive().optional(),
  idleTimeoutMs: z.number().positive().optional(),
  reuseContainers: z.boolean().optional(),
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
  allowNativeFallback: z.boolean().optional(),
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

export const FilterLayerSchema = z.enum(['input', 'output', 'tool']);

export const ConstitutionalPrincipleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['ethics', 'safety', 'privacy', 'legal', 'custom']),
  critiquePrompt: z.string(),
  revisionPrompt: z.string(),
  harmCategories: z.array(HarmCategorySchema).optional(),
  severity: SeveritySchema,
  appliesTo: z.array(FilterLayerSchema).optional(),
});

export const ConstitutionSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  principles: z.array(ConstitutionalPrincipleSchema),
  customizable: z.boolean(),
  strictMode: z.boolean(),
});

export const GuardrailConfigSchema = z.object({
  enabled: z.boolean().optional(),
  constitution: ConstitutionSchema.optional(),
  model: z.string().optional(),
  filterInput: z.boolean().optional(),
  filterOutput: z.boolean().optional(),
  filterToolCalls: z.boolean().optional(),
  filterToolResults: z.boolean().optional(),
  enableCritiqueRevision: z.boolean().optional(),
  maxRevisionIterations: z.number().positive().optional(),
  revisionConfidenceThreshold: z.number().min(0).max(1).optional(),
  thresholds: z.partialRecord(HarmCategorySchema, SeveritySchema).optional(),
  strictMode: z.boolean().optional(),
  logViolations: z.boolean().optional(),
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

const RegExpPatternSchema = z.union([
  z.instanceof(RegExp),
  z
    .string()
    .min(1)
    .refine(
      (source) => {
        try {
          new RegExp(source);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Invalid regular expression' }
    )
    .transform((source) => new RegExp(source)),
]);

export const PromptInjectionConfigSchema = z.object({
  detectInjection: z.boolean().optional(),
  detectJailbreak: z.boolean().optional(),
  detectRoleplay: z.boolean().optional(),
  detectEncoding: z.boolean().optional(),
  detectContextManipulation: z.boolean().optional(),
  patterns: z.array(RegExpPatternSchema).optional(),
  classifier: InjectionClassifierSchema.optional(),
  llmModel: z.string().optional(),
  action: InjectionActionSchema.optional(),
  threshold: z.number().min(0).max(1).optional(),
  failMode: z.enum(['secure', 'open']).optional(),
  allowlist: z.array(z.string()).optional(),
});

export const PiiTypeSchema = z.enum([
  'email',
  'phone',
  'credit_card',
  'iban',
  'ssn',
  'ip_address',
  'api_key',
]);

export const PiiConfigSchema = z.object({
  mode: z.enum(['mask', 'redact', 'block']).optional(),
  detect: z.array(PiiTypeSchema).optional(),
  custom: z.array(z.object({ type: z.string().min(1), pattern: RegExpPatternSchema })).optional(),
});

export const SecurityConfigSchema = z.object({
  promptInjection: PromptInjectionConfigSchema.optional(),
  pii: PiiConfigSchema.optional(),
});

export const CompressionStrategySchema = z.enum([
  'truncate',
  'sliding-window',
  'summarize',
  'hybrid',
]);

export const ClearToolOutputsConfigSchema = z.object({
  trigger: z.number().int().nonnegative().optional(),
  keep: z.number().int().nonnegative().optional(),
  exclude: z.array(z.string()).optional(),
  clearInputs: z.boolean().optional(),
  clearAtLeast: z.number().int().nonnegative().optional(),
});

export const ContextManagerConfigSchema = z.object({
  enabled: z.boolean().optional(),
  strategy: CompressionStrategySchema.optional(),
  compressionThreshold: z.number().positive().optional(),
  outputReserve: z.number().positive().optional(),
  summaryModel: z.string().optional(),
  windowSize: z.number().positive().optional(),
  clearToolOutputs: z.union([z.boolean(), ClearToolOutputsConfigSchema]).optional(),
});

export const DeployTargetSchema = z.enum(['docker', 'fly']);
export const DeployServerSchema = z.enum(['express', 'fastify', 'hono', 'koa', 'tetsu', 'next']);
export const DeployKindSchema = z.enum(['server', 'worker']);
export const DeployVolumeSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
  size: z.number().int().positive().optional(),
});

export const DeployConfigSchema = z.object({
  target: DeployTargetSchema.optional(),
  kind: DeployKindSchema.optional(),
  server: DeployServerSchema.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  registry: z.string().optional(),
  image: z.string().optional(),
  region: z.string().optional(),
  instances: z.number().int().positive().optional(),
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
  volumes: z.array(DeployVolumeSchema).optional(),
  hostGateway: z.boolean().optional(),
});

export const PromptsConfigSchema = z.object({
  autoDeployWinner: z.boolean().optional(),
});

export const CogitatorConfigSchema = z.object({
  llm: LLMConfigSchema.optional(),
  prompts: PromptsConfigSchema.optional(),
  limits: LimitsConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  reflection: ReflectionConfigSchema.optional(),
  guardrails: GuardrailConfigSchema.optional(),
  costRouting: CostRoutingConfigSchema.optional(),
  security: SecurityConfigSchema.optional(),
  context: ContextManagerConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  deploy: DeployConfigSchema.optional(),
});

export type CogitatorConfigInput = z.input<typeof CogitatorConfigSchema>;
export type CogitatorConfigOutput = z.output<typeof CogitatorConfigSchema>;
