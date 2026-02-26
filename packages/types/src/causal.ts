/**
 * @cogitator-ai/types - Causal Reasoning
 *
 * Types for Pearl's Ladder of Causation implementation:
 * - Level 1: Association P(Y|X)
 * - Level 2: Intervention P(Y|do(X))
 * - Level 3: Counterfactual P(Y_x|X', Y')
 */

export type CausalRelationType =
  | 'causes'
  | 'enables'
  | 'prevents'
  | 'mediates'
  | 'confounds'
  | 'moderates';

export type VariableType =
  | 'treatment'
  | 'outcome'
  | 'confounder'
  | 'mediator'
  | 'instrumental'
  | 'collider'
  | 'observed'
  | 'latent';

export type EquationType = 'linear' | 'logistic' | 'polynomial' | 'custom';

export interface StructuralEquation {
  type: EquationType;
  coefficients?: Record<string, number>;
  intercept?: number;
  customFn?: string;
  noiseDistribution?: 'gaussian' | 'uniform' | 'bernoulli';
  noiseParams?: Record<string, number>;
}

export interface CausalNode {
  id: string;
  name: string;
  variableType: VariableType;
  domain?: {
    type: 'continuous' | 'discrete' | 'binary' | 'categorical';
    values?: (string | number | boolean)[];
    min?: number;
    max?: number;
  };
  equation?: StructuralEquation;
  observedValue?: number | string | boolean;
  metadata?: Record<string, unknown>;
}

export interface CausalEdge {
  id: string;
  source: string;
  target: string;
  relationType: CausalRelationType;
  strength: number;
  confidence: number;
  mechanism?: string;
  timelag?: number;
  conditions?: string[];
  metadata?: Record<string, unknown>;
}

export interface CausalPath {
  nodes: string[];
  edges: CausalEdge[];
  totalStrength: number;
  isBlocked: boolean;
  blockingNodes: string[];
}

export interface CausalGraphData {
  id: string;
  name: string;
  nodes: CausalNode[];
  edges: CausalEdge[];
  createdAt: number;
  updatedAt: number;
  version: number;
  metadata?: Record<string, unknown>;
}

export interface CausalGraph {
  readonly id: string;
  readonly name: string;

  addNode(node: CausalNode): void;
  removeNode(nodeId: string): void;
  getNode(nodeId: string): CausalNode | undefined;
  getNodes(): CausalNode[];
  hasNode(nodeId: string): boolean;

  addEdge(edge: CausalEdge): void;
  removeEdge(edgeId: string): void;
  getEdge(edgeId: string): CausalEdge | undefined;
  getEdges(): CausalEdge[];
  getEdgeBetween(source: string, target: string): CausalEdge | undefined;

  getParents(nodeId: string): CausalNode[];
  getChildren(nodeId: string): CausalNode[];
  getAncestors(nodeId: string): CausalNode[];
  getDescendants(nodeId: string): CausalNode[];

  findPaths(from: string, to: string, maxLength?: number): CausalPath[];
  getMarkovBlanket(nodeId: string): CausalNode[];

  topologicalSort(): string[];
  hasCycle(): boolean;

  clone(): CausalGraph;
  toData(): CausalGraphData;
}

export type TripleType = 'chain' | 'fork' | 'collider';

export interface DSeparationResult {
  separated: boolean;
  paths: CausalPath[];
  blockedPaths: CausalPath[];
  openPaths: CausalPath[];
}

export interface AdjustmentSet {
  variables: string[];
  type: 'backdoor' | 'frontdoor';
  formula: string;
  isMinimal: boolean;
  isValid: boolean;
}

export interface InterventionQuery {
  target: string;
  interventions: Record<string, number | string | boolean>;
  conditions?: Record<string, number | string | boolean>;
}

export interface CounterfactualQuery {
  target: string;
  intervention: Record<string, number | string | boolean>;
  factual: Record<string, number | string | boolean>;
  question: string;
}

export interface CausalEffectEstimate {
  effect: number;
  standardError?: number;
  confidenceInterval?: [number, number];
  pValue?: number;
  adjustmentSet: AdjustmentSet;
  isIdentifiable: boolean;
  formula: string;
}

export interface CounterfactualResult {
  query: CounterfactualQuery;
  factualValue: number | string | boolean;
  counterfactualValue: number | string | boolean;
  probability?: number;
  explanation: string;
  reasoning: {
    abduction: Record<string, number>;
    action: Record<string, number | string | boolean>;
    prediction: Record<string, number | string | boolean>;
  };
}

export interface CausalHypothesis {
  id: string;
  cause: string;
  effect: string;
  relationType: CausalRelationType;
  strength: number;
  confidence: number;
  source: 'extraction' | 'observation' | 'intervention' | 'counterfactual';
  evidence: CausalEvidence[];
  status: 'pending' | 'testing' | 'validated' | 'rejected';
  createdAt: number;
  testedAt?: number;
}

export interface CausalEvidence {
  type: 'observational' | 'interventional' | 'counterfactual';
  description: string;
  strength: number;
  traceId?: string;
  timestamp: number;
}

export interface CausalPattern {
  id: string;
  agentId: string;
  pattern: {
    trigger: string;
    effect: string;
    conditions: string[];
  };
  occurrences: number;
  successRate: number;
  avgStrength: number;
  lastSeen: number;
  createdAt: number;
}

export interface PredictedEffect {
  action: string;
  effects: Array<{
    variable: string;
    expectedValue: number | string | boolean;
    probability: number;
    mechanism: string;
  }>;
  sideEffects: Array<{
    variable: string;
    expectedValue: number | string | boolean;
    probability: number;
    unintended: boolean;
  }>;
  confidence: number;
  reasoning: string;
}

export interface CausalActionEvaluation {
  action: string;
  isSafe: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  predictedEffects: PredictedEffect;
  warnings: string[];
  recommendations: string[];
  blockedReasons?: string[];
}

export interface RootCause {
  variable: string;
  contribution: number;
  mechanism: string;
  path: CausalPath;
  confidence: number;
  actionable: boolean;
  suggestedIntervention?: string;
}

export interface CausalExplanation {
  effect: string;
  effectValue: number | string | boolean;
  rootCauses: RootCause[];
  contributingFactors: Array<{
    variable: string;
    contribution: number;
    direction: 'positive' | 'negative';
  }>;
  counterfactuals: Array<{
    change: string;
    wouldPrevent: boolean;
    confidence: number;
  }>;
  summary: string;
  confidence: number;
}

export interface CausalPlanStep {
  order: number;
  action: string;
  target: string;
  value: number | string | boolean;
  expectedEffect: PredictedEffect;
  preconditions: string[];
  alternatives?: CausalPlanStep[];
}

export interface CausalPlan {
  goal: string;
  goalValue: number | string | boolean;
  steps: CausalPlanStep[];
  expectedOutcome: {
    probability: number;
    confidence: number;
  };
  robustness: {
    score: number;
    vulnerabilities: string[];
    backupPlans: CausalPlan[];
  };
  estimatedCost: number;
  reasoning: string;
}

export interface InterventionRecord {
  id: string;
  agentId: string;
  intervention: Record<string, number | string | boolean>;
  observedBefore: Record<string, number | string | boolean>;
  observedAfter: Record<string, number | string | boolean>;
  expectedEffect: PredictedEffect;
  actualEffect: Record<string, number | string | boolean>;
  success: boolean;
  timestamp: number;
  traceId?: string;
}

export interface CausalGraphStore {
  save(graph: CausalGraphData): Promise<void>;
  load(graphId: string): Promise<CausalGraphData | null>;
  loadForAgent(agentId: string): Promise<CausalGraphData | null>;
  delete(graphId: string): Promise<void>;
  list(agentId?: string): Promise<CausalGraphData[]>;
}

export interface CausalPatternStore {
  save(pattern: CausalPattern): Promise<void>;
  findRelevant(
    agentId: string,
    context: { trigger?: string; effect?: string },
    limit: number
  ): Promise<CausalPattern[]>;
  markUsed(patternId: string): Promise<void>;
  prune(agentId: string, maxAge: number, maxCount: number): Promise<number>;
  getStats(agentId: string): Promise<{
    totalPatterns: number;
    avgSuccessRate: number;
    topPatterns: CausalPattern[];
  }>;
}

export interface InterventionLog {
  log(record: InterventionRecord): Promise<void>;
  getHistory(agentId: string, limit: number): Promise<InterventionRecord[]>;
  findSimilar(
    agentId: string,
    intervention: Record<string, number | string | boolean>
  ): Promise<InterventionRecord[]>;
  getStats(agentId: string): Promise<{
    totalInterventions: number;
    successRate: number;
    avgEffectAccuracy: number;
  }>;
}

export interface CausalReasoningConfig {
  enabled: boolean;
  maxGraphNodes: number;
  maxGraphEdges: number;
  minEdgeConfidence: number;
  minEdgeStrength: number;
  hypothesisValidationThreshold: number;
  enableSafetyChecks: boolean;
  blockDangerousActions: boolean;
  maxPathLength: number;
  pruneInterval: number;
  patternMaxAge: number;
  patternMaxCount: number;
  enableCounterfactual: boolean;
  enableLLMDiscovery: boolean;
  discoveryBatchSize: number;
}

export const DEFAULT_CAUSAL_CONFIG: CausalReasoningConfig = {
  enabled: true,
  maxGraphNodes: 1000,
  maxGraphEdges: 5000,
  minEdgeConfidence: 0.3,
  minEdgeStrength: 0.1,
  hypothesisValidationThreshold: 0.7,
  enableSafetyChecks: true,
  blockDangerousActions: false,
  maxPathLength: 10,
  pruneInterval: 3600000,
  patternMaxAge: 604800000,
  patternMaxCount: 1000,
  enableCounterfactual: true,
  enableLLMDiscovery: true,
  discoveryBatchSize: 5,
};

export interface CausalReasonerStats {
  graphNodes: number;
  graphEdges: number;
  hypothesesPending: number;
  hypothesesValidated: number;
  hypothesesRejected: number;
  patternsStored: number;
  interventionsLogged: number;
  predictionsAccuracy: number;
  explanationsGenerated: number;
  plansGenerated: number;
}

export interface CausalContext {
  agentId: string;
  taskId?: string;
  observedVariables: Record<string, number | string | boolean>;
  activeInterventions: Record<string, number | string | boolean>;
  recentPatterns: CausalPattern[];
  timestamp: number;
}
