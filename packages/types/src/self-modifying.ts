import type { Tool } from './tool';

export type ReasoningMode =
  | 'analytical'
  | 'creative'
  | 'systematic'
  | 'intuitive'
  | 'reflective'
  | 'exploratory';

export interface ReasoningModeConfig {
  mode: ReasoningMode;
  temperature: number;
  depth: number;
  parameters?: Record<string, unknown>;
}

export interface CapabilityGap {
  id: string;
  description: string;
  requiredCapability: string;
  suggestedToolName: string;
  complexity: 'simple' | 'moderate' | 'complex';
  confidence: number;
  reasoning?: string;
  priority?: number;
}

export interface GapAnalysisResult {
  gaps: CapabilityGap[];
  analysis: {
    intentCoverage: number;
    suggestedCompositions: Array<{ tools: string[]; description: string }>;
    canProceedWithExisting: boolean;
    reasoning: string;
  };
  timestamp: Date;
}

export interface ToolGenerationRequest {
  gap: CapabilityGap;
  existingTools: Array<{ name: string; description: string }>;
  testCases?: Array<{ input: unknown; expectedOutput?: unknown }>;
}

export interface GeneratedTool {
  id: string;
  name: string;
  description: string;
  implementation: string;
  parameters: Record<string, unknown>;
  createdAt: Date;
  updatedAt?: Date;
  version: number;
  status: 'pending_validation' | 'validated' | 'active' | 'deprecated' | 'failed';
  validationScore?: number;
  usageCount?: number;
  lastUsed?: Date;
  metadata?: Record<string, unknown>;
}

export interface ToolValidationResult {
  isValid: boolean;
  securityIssues: string[];
  logicIssues: string[];
  edgeCases: string[];
  suggestions: string[];
  testResults: Array<{
    input: unknown;
    output?: unknown;
    passed: boolean;
    error?: string;
  }>;
  overallScore: number;
}

export interface ToolSandboxConfig {
  enabled: boolean;
  maxExecutionTime: number;
  maxMemory: number;
  allowedModules: string[];
  isolationLevel: 'strict' | 'moderate' | 'permissive';
}

export interface ToolSandboxResult {
  success: boolean;
  result?: unknown;
  error?: string;
  executionTime: number;
  memoryUsed: number;
  logs: string[];
}

export interface GeneratedToolStore {
  save(tool: GeneratedTool): Promise<void>;
  get(id: string): Promise<GeneratedTool | null>;
  getByName(name: string): Promise<GeneratedTool | null>;
  list(filter?: { status?: GeneratedTool['status']; minScore?: number }): Promise<GeneratedTool[]>;
  delete(id: string): Promise<boolean>;
}

export interface ToolSelfGenerationConfig {
  enabled: boolean;
  autoGenerate: boolean;
  maxToolsPerSession: number;
  minConfidenceForGeneration: number;
  maxIterationsPerTool: number;
  requireLLMValidation: boolean;
  sandboxConfig?: ToolSandboxConfig;
  maxComplexity?: 'simple' | 'moderate' | 'complex';
}

export type MetaTrigger =
  | 'on_failure'
  | 'on_low_confidence'
  | 'on_stagnation'
  | 'periodic'
  | 'on_request'
  | 'iteration_complete'
  | 'confidence_drop'
  | 'progress_stall'
  | 'tool_call_failed'
  | 'explicit_request';

export interface MetaObservation {
  id?: string;
  runId: string;
  iteration: number;
  timestamp: number;
  goal?: string;
  currentMode: ReasoningMode;
  currentConfidence: number;
  progressScore: number;
  progressDelta: number;
  stagnationCount: number;
  confidenceHistory: number[];
  tokensUsed: number;
  timeElapsed: number;
  iterationsRemaining?: number;
  budgetRemaining?: number;
  toolSuccessRate: number;
  errorRate?: number;
  repetitionScore: number;
  confidenceTrend: 'rising' | 'stable' | 'falling';
  recentActions?: Array<{
    type: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  }>;
  recentInsights?: unknown[];
  actionCount?: number;
  failedActions?: number;
}

export interface MetaIssue {
  type: 'stagnation' | 'low_confidence' | 'high_cost' | 'repetition' | 'tool_failure';
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface MetaOpportunity {
  type: 'mode_switch' | 'parameter_tune' | 'context_add' | 'tool_compose';
  confidence: number;
  description: string;
}

export interface MetaRecommendation {
  action: 'continue' | 'switch_mode' | 'adjust_parameters' | 'inject_context' | 'abort';
  newMode?: ReasoningMode;
  parameterChanges?: Partial<ReasoningModeConfig>;
  contextAddition?: string;
  confidence: number;
  reasoning: string;
}

export interface MetaAssessment {
  id: string;
  observationId: string;
  timestamp: number;
  onTrack: boolean;
  confidence: number;
  reasoning: string;
  issues: MetaIssue[];
  opportunities: MetaOpportunity[];
  recommendation: MetaRecommendation;
  requiresAdaptation?: boolean;
  suggestedMode?: ReasoningMode;
  assessmentDuration: number;
  assessmentCost: number;
}

export interface MetaAdaptation {
  id: string;
  assessmentId: string;
  timestamp: number;
  type: 'mode_switch' | 'parameter_change' | 'context_injection' | 'rollback';
  before: Partial<ReasoningModeConfig>;
  after: Partial<ReasoningModeConfig>;
  previousMode?: ReasoningMode;
  newMode?: ReasoningMode;
  reason?: string;
  isRollback?: boolean;
  rollbackable: boolean;
  rollbackDeadline?: number;
  outcome?: {
    improved: boolean;
    progressDelta: number;
    confidenceDelta: number;
  };
}

export interface MetaReasoningConfig {
  enabled: boolean;
  defaultMode: ReasoningMode;
  allowedModes: ReasoningMode[];
  modeProfiles: Record<ReasoningMode, ReasoningModeConfig>;
  maxMetaAssessments: number;
  maxAdaptations: number;
  metaAssessmentCooldown: number;
  adaptationCooldown: number;
  triggers: MetaTrigger[];
  triggerAfterIterations: number;
  triggerOnConfidenceDrop: number;
  triggerOnProgressStall: number;
  tokenBudget: number;
  metaModel?: string;
  maxMetaTokens?: number;
  minConfidenceToAdapt: number;
  enableRollback: boolean;
  rollbackWindow: number;
  rollbackOnDecline: boolean;
}

export interface TaskProfile {
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'extreme' | 'expert';
  domain: 'general' | 'coding' | 'reasoning' | 'creative' | 'factual' | 'conversational';
  estimatedTokens: number;
  requiresTools: boolean;
  requiresReasoning?: boolean;
  requiresCreativity?: boolean;
  toolIntensity: 'none' | 'light' | 'moderate' | 'heavy';
  reasoningDepth: 'shallow' | 'moderate' | 'deep' | 'exhaustive';
  creativityLevel: 'low' | 'moderate' | 'high';
  accuracyRequirement: 'approximate' | 'moderate' | 'high' | 'critical';
  timeConstraint: 'none' | 'relaxed' | 'moderate' | 'strict';
}

export interface ArchitectureConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  toolStrategy: 'sequential' | 'parallel' | 'adaptive';
  reflectionDepth: number;
}

export interface EvolvableParameter {
  name: string;
  type: 'continuous' | 'discrete' | 'categorical';
  range?: [number, number];
  values?: unknown[];
  current: unknown;
}

export interface EvolutionCandidate {
  id: string;
  config: Partial<ArchitectureConfig>;
  reasoning?: string;
  expectedImprovement: number;
  risk: 'low' | 'medium' | 'high';
  generation: number;
  score: number;
  evaluationCount: number;
}

export interface EvolutionMetrics {
  generation: number;
  bestScore: number;
  averageScore: number;
  diversity: number;
  convergenceRate: number;
}

export interface EvolutionStrategy {
  type: 'epsilon_greedy' | 'ucb' | 'thompson_sampling';
  epsilon?: number;
  explorationConstant?: number;
}

export interface ArchitectureEvolutionConfig {
  enabled: boolean;
  strategy: EvolutionStrategy;
  maxCandidates?: number;
  evaluationWindow?: number;
  minEvaluationsBeforeEvolution?: number;
  adaptationThreshold?: number;
}

export interface SafetyConstraint {
  id: string;
  name?: string;
  rule: string;
  severity: 'warning' | 'error' | 'critical';
  description: string;
}

export interface CapabilityConstraint {
  id: string;
  name?: string;
  type: string;
  limit?: number;
  description: string;
  allowed?: string[];
  forbidden?: string[];
  maxComplexity?: number;
}

export interface ResourceConstraint {
  id: string;
  name?: string;
  resource: string;
  maxValue?: number;
  description: string;
  maxMemory?: number;
  maxTokensPerRun?: number;
  maxCostPerRun?: number;
  maxToolsActive?: number;
}

export interface CustomConstraint {
  id: string;
  name: string;
  description: string;
  predicate: (request: ModificationRequest) => boolean | Promise<boolean>;
}

export interface ConstraintCheckResult {
  constraintId: string;
  constraintName?: string;
  satisfied: boolean;
  message?: string;
  severity: 'warning' | 'error' | 'critical';
}

export type ConstraintRule =
  | string
  | {
      type: string;
      expression?: string;
      pattern?: RegExp;
    };

export interface ModificationRequest {
  type: 'tool_creation' | 'config_change' | 'strategy_change' | 'tool_generation';
  target: string;
  changes: unknown;
  reason: string;
  context?: Record<string, unknown>;
  payload?: unknown;
}

export interface ModificationConstraints {
  safety: SafetyConstraint[];
  capability: CapabilityConstraint[];
  resource: ResourceConstraint[];
  custom?: CustomConstraint[];
}

export interface ModificationValidationResult {
  valid: boolean;
  constraintResults?: ConstraintCheckResult[];
  errors?: string[];
  warnings: string[];
  rollbackRequired?: boolean;
}

export interface AppliedModification {
  id: string;
  type: string;
  appliedAt: Date;
  data: unknown;
}

export interface ModificationCheckpoint {
  id: string;
  agentId: string;
  timestamp: Date;
  agentConfig: Record<string, unknown>;
  tools: Tool[];
  modifications: AppliedModification[];
}

export interface ModificationConstraintsConfig {
  enabled: boolean;
  autoRollback: boolean;
  rollbackWindow: number;
  maxModificationsPerRun: number;
}

export interface SelfModifyingConfig {
  enabled: boolean;
  toolGeneration: ToolSelfGenerationConfig;
  metaReasoning: MetaReasoningConfig;
  architectureEvolution: ArchitectureEvolutionConfig;
  constraints: ModificationConstraintsConfig;
}

export type SelfModifyingEventType =
  | 'run_started'
  | 'run_completed'
  | 'tool_generation_started'
  | 'tool_generation_completed'
  | 'meta_assessment'
  | 'strategy_changed'
  | 'architecture_evolved'
  | 'checkpoint_created'
  | 'rollback_performed';

export interface SelfModifyingEvent {
  type: SelfModifyingEventType;
  runId: string;
  agentId?: string;
  timestamp: Date;
  data: unknown;
}

export type SelfModifyingEventHandler = (event: SelfModifyingEvent) => void;

export const DEFAULT_MODE_PROFILES: Record<ReasoningMode, ReasoningModeConfig> = {
  analytical: { mode: 'analytical', temperature: 0.3, depth: 3 },
  creative: { mode: 'creative', temperature: 0.9, depth: 2 },
  systematic: { mode: 'systematic', temperature: 0.2, depth: 4 },
  intuitive: { mode: 'intuitive', temperature: 0.6, depth: 1 },
  reflective: { mode: 'reflective', temperature: 0.4, depth: 3 },
  exploratory: { mode: 'exploratory', temperature: 0.7, depth: 2 },
};

export const DEFAULT_META_REASONING_CONFIG: MetaReasoningConfig = {
  enabled: true,
  defaultMode: 'analytical',
  allowedModes: ['analytical', 'creative', 'systematic', 'intuitive', 'reflective', 'exploratory'],
  modeProfiles: DEFAULT_MODE_PROFILES,
  maxMetaAssessments: 5,
  maxAdaptations: 3,
  metaAssessmentCooldown: 10000,
  adaptationCooldown: 15000,
  triggers: ['on_failure', 'on_low_confidence', 'periodic'],
  triggerAfterIterations: 3,
  triggerOnConfidenceDrop: 0.3,
  triggerOnProgressStall: 2,
  tokenBudget: 2000,
  maxMetaTokens: 1000,
  minConfidenceToAdapt: 0.6,
  enableRollback: true,
  rollbackWindow: 30000,
  rollbackOnDecline: true,
};

export const DEFAULT_SAFETY_CONSTRAINTS: SafetyConstraint[] = [
  {
    id: 'no_arbitrary_code',
    rule: 'sandboxExecution = true',
    severity: 'critical',
    description: 'Generated tools must run in sandbox',
  },
  {
    id: 'max_tool_complexity',
    rule: 'linesOfCode < 100',
    severity: 'error',
    description: 'Generated tools must be under 100 lines',
  },
  {
    id: 'no_self_modification_loop',
    rule: 'modificationDepth < 3',
    severity: 'critical',
    description: 'Prevent recursive self-modification',
  },
];
