/**
 * Tree of Thoughts (ToT) reasoning types
 *
 * Enables branching reasoning with:
 * - Multiple thought candidates per step
 * - Confidence-based branch evaluation
 * - Beam search exploration
 * - Backtracking on dead ends
 */

import type { Message, ToolResult } from './message';

export type ExplorationStrategy = 'beam' | 'best-first' | 'dfs';

export interface ToTConfig {
  branchFactor: number;
  beamWidth: number;
  maxDepth: number;
  explorationStrategy: ExplorationStrategy;

  confidenceThreshold: number;
  terminationConfidence: number;

  maxTotalNodes: number;
  maxIterationsPerBranch: number;
  timeout?: number;

  onBranchGenerated?: (node: ThoughtNode, branches: ThoughtBranch[]) => void;
  onBranchEvaluated?: (branch: ThoughtBranch, score: BranchScore) => void;
  onNodeExplored?: (node: ThoughtNode) => void;
  onBacktrack?: (from: ThoughtNode, to: ThoughtNode | null) => void;
}

export type ProposedActionType = 'tool_call' | 'response' | 'sub_goal';

export type ProposedAction =
  | { type: 'tool_call'; toolName: string; arguments: Record<string, unknown> }
  | { type: 'response'; content: string }
  | { type: 'sub_goal'; goal: string };

export interface BranchScore {
  confidence: number;
  progress: number;
  novelty: number;
  composite: number;
  reasoning: string;
}

export interface ThoughtBranch {
  id: string;
  parentId: string | null;
  thought: string;
  proposedAction: ProposedAction;
  score?: BranchScore;
  messagesSnapshot: Message[];
}

export type ThoughtNodeStatus = 'pending' | 'exploring' | 'completed' | 'failed' | 'pruned';

export interface ThoughtNodeResult {
  toolResult?: ToolResult;
  response?: string;
  error?: string;
}

export interface ThoughtNode {
  id: string;
  parentId: string | null;
  depth: number;
  branch: ThoughtBranch;
  result?: ThoughtNodeResult;
  messages: Message[];
  status: ThoughtNodeStatus;
  cumulativeScore: number;
  children: string[];
  createdAt: number;
  exploredAt?: number;
}

export interface ToTStats {
  totalNodes: number;
  exploredNodes: number;
  prunedNodes: number;
  maxDepthReached: number;
  backtrackCount: number;
  duration: number;
  llmCalls: number;
  tokenUsage: {
    input: number;
    output: number;
  };
}

export interface ThoughtTree {
  id: string;
  goal: string;
  agentId: string;
  root: ThoughtNode;
  nodes: Map<string, ThoughtNode>;
  bestPath: string[];
  bestScore: number;
  stats: ToTStats;
}

export interface ToTResult {
  success: boolean;
  output: string;
  tree: ThoughtTree;
  bestPath: ThoughtNode[];
  stats: ToTStats;
  runId: string;
  agentId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
}

export interface ToTRunOptions {
  timeout?: number;
  abortSignal?: AbortSignal;
  onProgress?: (stats: ToTStats) => void;
}

export const DEFAULT_TOT_CONFIG: Required<Omit<ToTConfig, 'timeout' | 'onBranchGenerated' | 'onBranchEvaluated' | 'onNodeExplored' | 'onBacktrack'>> = {
  branchFactor: 3,
  beamWidth: 2,
  maxDepth: 5,
  explorationStrategy: 'beam',
  confidenceThreshold: 0.3,
  terminationConfidence: 0.8,
  maxTotalNodes: 50,
  maxIterationsPerBranch: 3,
};
