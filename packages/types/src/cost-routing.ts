export type {
  TaskComplexity,
  ReasoningLevel,
  SpeedPreference,
  CostSensitivity,
  TaskRequirements,
} from './swarm';

export interface ModelRecommendation {
  modelId: string;
  provider: string;
  score: number;
  reasons: string[];
  estimatedCost: number;
  fallbacks: string[];
}

export interface CostRecord {
  runId: string;
  agentId: string;
  threadId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: Date;
}

export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byModel: Record<string, number>;
  byAgent: Record<string, number>;
  runCount: number;
}

export interface BudgetConfig {
  maxCostPerRun?: number;
  maxCostPerHour?: number;
  maxCostPerDay?: number;
  warningThreshold?: number;
  onBudgetWarning?: (current: number, limit: number) => void;
  onBudgetExceeded?: (current: number, limit: number) => void;
}

export interface CostRoutingConfig {
  enabled: boolean;
  autoSelectModel?: boolean;
  preferLocal?: boolean;
  minCapabilityMatch?: number;
  budget?: BudgetConfig;
  trackCosts?: boolean;
  ollamaUrl?: string;
}

export const DEFAULT_COST_ROUTING_CONFIG: CostRoutingConfig = {
  enabled: true,
  autoSelectModel: false,
  preferLocal: true,
  minCapabilityMatch: 0.3,
  trackCosts: true,
};
