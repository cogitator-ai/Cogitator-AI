/**
 * Reflection types for self-analyzing agents
 *
 * Enables agents to:
 * - Analyze their actions and outcomes
 * - Extract learnings from successes and failures
 * - Store insights for future use
 * - Improve over time
 */

import type { Evidence } from './memory';

export type ReflectionActionType = 'tool_call' | 'response' | 'decision' | 'error';
export type InsightType = 'pattern' | 'mistake' | 'success' | 'tip' | 'warning';

export interface ReflectionAction {
  type: ReflectionActionType;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  duration?: number;
}

export interface ReflectionAnalysis {
  wasSuccessful: boolean;
  confidence: number;
  reasoning: string;
  alternativesConsidered?: string[];
  whatCouldImprove?: string;
}

export interface Insight {
  id: string;
  type: InsightType;
  content: string;
  context: string;
  confidence: number;
  usageCount: number;
  createdAt: Date;
  lastUsedAt: Date;
  agentId: string;
  source: {
    runId: string;
    reflectionId: string;
  };
  /** Where it comes from, word for word: entries, tool results or files it stands on */
  evidence?: Evidence[];
}

export interface Reflection {
  id: string;
  runId: string;
  agentId: string;
  timestamp: Date;
  action: ReflectionAction;
  analysis: ReflectionAnalysis;
  insights: Insight[];
  goal?: string;
  iterationIndex: number;
}

export interface ReflectionConfig {
  enabled: boolean;
  reflectAfterToolCall?: boolean;
  reflectAfterError?: boolean;
  reflectAtEnd?: boolean;
  storeInsights?: boolean;
  maxInsightsPerAgent?: number;
  minConfidenceToStore?: number;
  useSmallModelForReflection?: boolean;
  reflectionModel?: string;
}

export interface InsightQuery {
  agentId?: string;
  types?: InsightType[];
  minConfidence?: number;
  limit?: number;
  context?: string;
}

export interface InsightStore {
  store(insight: Insight): Promise<void>;
  storeMany(insights: Insight[]): Promise<void>;
  findRelevant(agentId: string, context: string, limit?: number): Promise<Insight[]>;
  getAll(agentId: string): Promise<Insight[]>;
  getById(id: string): Promise<Insight | null>;
  markUsed(id: string): Promise<void>;
  prune(agentId: string, maxInsights: number): Promise<number>;
  delete(id: string): Promise<boolean>;
  clear(agentId: string): Promise<void>;
}

export interface ReflectionResult {
  reflection: Reflection;
  shouldAdjustStrategy: boolean;
  suggestedAction?: string;
}

export interface AgentContext {
  agentId: string;
  agentName: string;
  runId: string;
  threadId: string;
  goal: string;
  iterationIndex: number;
  previousActions: ReflectionAction[];
  availableTools: string[];
}

export interface ReflectionEngineConfig extends ReflectionConfig {
  insightStore: InsightStore;
}

export interface ReflectionSummary {
  totalReflections: number;
  successRate: number;
  averageConfidence: number;
  topInsights: Insight[];
  commonMistakes: string[];
  learnedPatterns: string[];
}
