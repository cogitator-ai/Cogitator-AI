import { nanoid } from 'nanoid';
import type {
  ToTConfig,
  ToTResult,
  ToTStats,
  ToTRunOptions,
  ThoughtTree,
  ThoughtNode,
  ThoughtBranch,
  Agent,
  AgentContext,
  ChatUsage,
  LLMBackend,
} from '@cogitator-ai/types';
import { DEFAULT_TOT_CONFIG } from '@cogitator-ai/types';
import { calculateCost } from '@cogitator-ai/models';
import { parseModel } from '../llm/index';
import type { Cogitator } from '../runtime';
import { BranchGenerator } from './branch-generator';
import { BranchEvaluator } from './branch-evaluator';
import { buildSynthesisPrompt } from './prompts';
import { ReflectionEngine } from '../reflection/index';

function generateId(): string {
  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function branchScore(node: ThoughtNode): number {
  return node.branch.score?.composite ?? 0;
}

function pendingFirst(a: ThoughtNode, b: ThoughtNode): number {
  return Number(b.status === 'pending') - Number(a.status === 'pending');
}

export class ThoughtTreeExecutor {
  private cogitator: Cogitator;
  private config: Required<
    Omit<
      ToTConfig,
      'timeout' | 'onBranchGenerated' | 'onBranchEvaluated' | 'onNodeExplored' | 'onBacktrack'
    >
  > &
    Partial<
      Pick<
        ToTConfig,
        'timeout' | 'onBranchGenerated' | 'onBranchEvaluated' | 'onNodeExplored' | 'onBacktrack'
      >
    >;
  private branchGenerator!: BranchGenerator;
  private branchEvaluator!: BranchEvaluator;
  private llm?: LLMBackend;
  private model = '';
  private modelString = '';

  private nodes = new Map<string, ThoughtNode>();
  private open: ThoughtNode[] = [];
  private queued = new Set<string>();
  private stats: ToTStats = this.createInitialStats();
  private cost = 0;

  constructor(cogitator: Cogitator, config: Partial<ToTConfig> = {}) {
    this.cogitator = cogitator;
    this.config = { ...DEFAULT_TOT_CONFIG, ...config };
  }

  async explore(agent: Agent, goal: string, options: ToTRunOptions = {}): Promise<ToTResult> {
    const runId = `tot_${nanoid(12)}`;
    const startTime = Date.now();

    this.nodes.clear();
    this.open = [];
    this.queued.clear();
    this.stats = this.createInitialStats();
    this.cost = 0;

    this.modelString = this.cogitator.resolveModel(agent);
    const route = this.cogitator.route(this.modelString, agent.config.provider);
    this.model = route.model;
    this.llm = this.trackUsage(route.backend);

    this.branchGenerator = new BranchGenerator(this.llm, this.model);
    this.branchEvaluator = new BranchEvaluator({
      llm: this.llm,
      model: this.model,
      reflectionEngine: this.getReflectionEngine(),
    });

    const context = this.buildAgentContext(agent, goal);
    const branchAgent = this.createBranchAgent(agent);

    const root = this.createRootNode(goal);
    this.nodes.set(root.id, root);
    this.enqueue([root]);

    let bestNode: ThoughtNode | null = null;

    const timeout = options.timeout ?? this.config.timeout;
    const timeoutAt = timeout ? startTime + timeout : null;
    const abortSignal = options.abortSignal;

    while (this.open.length > 0) {
      if (abortSignal?.aborted) {
        break;
      }
      if (timeoutAt && Date.now() > timeoutAt) {
        break;
      }
      if (this.stats.exploredNodes >= this.config.maxTotalNodes) {
        break;
      }

      const node = this.dequeue();

      if (node.parentId !== null && node.status === 'pending') {
        const status = await this.executeNode(node, branchAgent, goal);

        if (
          status === 'completed' &&
          (!bestNode || node.cumulativeScore > bestNode.cumulativeScore)
        ) {
          bestNode = node;
        }

        if (this.shouldTerminate(node)) {
          return this.createResult(runId, goal, agent.id, node, startTime);
        }

        if (status === 'failed') {
          this.backtrack(node);
        } else if (node.depth < this.config.maxDepth) {
          this.enqueue([node]);
        }
      } else {
        await this.expandNode(node, goal, context);
      }

      options.onProgress?.(this.stats);
    }

    const resultNode = bestNode ?? this.findBestNode();
    return this.createResult(runId, goal, agent.id, resultNode, startTime);
  }

  private createRootNode(goal: string): ThoughtNode {
    const rootBranch: ThoughtBranch = {
      id: generateId(),
      parentId: null,
      thought: `Starting exploration for: ${goal}`,
      proposedAction: { type: 'sub_goal', goal },
      messagesSnapshot: [],
    };

    return {
      id: generateId(),
      parentId: null,
      depth: 0,
      branch: rootBranch,
      messages: [],
      status: 'pending',
      cumulativeScore: 0,
      children: [],
      createdAt: Date.now(),
    };
  }

  /**
   * Generates and scores the candidate approaches from `node`. Every candidate
   * at or above `confidenceThreshold` becomes a pending child; the best
   * `beamWidth` of them are queued, the rest stay as alternatives to backtrack to.
   */
  private async expandNode(node: ThoughtNode, goal: string, context: AgentContext): Promise<void> {
    if (node.status === 'pending') {
      node.status = 'exploring';
      node.exploredAt = Date.now();
    }

    const branches = await this.branchGenerator.generate(
      node.parentId === null ? null : node,
      goal,
      this.config.branchFactor,
      context,
      this.getExploredThoughts()
    );
    this.config.onBranchGenerated?.(node, branches);

    const scores = await this.branchEvaluator.evaluateBatch(branches, goal, context);

    for (const branch of branches) {
      const score = scores.get(branch.id);
      if (score) {
        branch.score = score;
        this.config.onBranchEvaluated?.(branch, score);
      }
    }

    const candidates = branches
      .filter((b) => b.score && b.score.composite >= this.config.confidenceThreshold)
      .sort((a, b) => (b.score?.composite ?? 0) - (a.score?.composite ?? 0));
    this.stats.prunedNodes += branches.length - candidates.length;

    if (candidates.length === 0) {
      this.backtrack(node);
      return;
    }

    const children = candidates.map((branch) => this.addChild(branch, node));
    this.enqueue(children.slice(0, this.config.beamWidth));
  }

  private addChild(branch: ThoughtBranch, parent: ThoughtNode): ThoughtNode {
    const node: ThoughtNode = {
      id: generateId(),
      parentId: parent.id,
      depth: parent.depth + 1,
      branch: { ...branch, parentId: parent.id },
      messages: [...branch.messagesSnapshot],
      status: 'pending',
      cumulativeScore: parent.cumulativeScore + (branch.score?.composite ?? 0),
      children: [],
      createdAt: Date.now(),
    };

    parent.children.push(node.id);
    this.nodes.set(node.id, node);
    this.stats.totalNodes++;
    return node;
  }

  private async executeNode(
    node: ThoughtNode,
    agent: Agent,
    goal: string
  ): Promise<'completed' | 'failed'> {
    node.status = 'exploring';
    this.stats.exploredNodes++;
    this.stats.maxDepthReached = Math.max(this.stats.maxDepthReached, node.depth);

    const action = node.branch.proposedAction;
    let status: 'completed' | 'failed' = 'completed';
    if (action.type === 'response') {
      node.result = { response: action.content };
    } else {
      try {
        const result = await this.cogitator.run(agent, {
          input: this.buildNodePrompt(node.branch, goal),
          useMemory: false,
        });

        this.stats.tokenUsage.input += result.usage.inputTokens;
        this.stats.tokenUsage.output += result.usage.outputTokens;
        this.cost += result.usage.cost;

        node.result = { response: result.output };
        node.messages = [...result.messages];
      } catch (error) {
        node.result = { error: error instanceof Error ? error.message : String(error) };
        status = 'failed';
      }
    }

    node.status = status;
    node.exploredAt = Date.now();
    this.config.onNodeExplored?.(node);
    return status;
  }

  private enqueue(nodes: ThoughtNode[]): void {
    const ordered = this.config.explorationStrategy === 'dfs' ? [...nodes].reverse() : nodes;
    for (const node of ordered) {
      this.open.push(node);
      this.queued.add(node.id);
    }
  }

  /**
   * Takes the next node off the frontier: the most recently queued one for
   * `dfs`, the one whose own branch scored highest for `best-first`, and the
   * shallowest one for `beam`, so a whole level runs before the next is generated.
   */
  private dequeue(): ThoughtNode {
    let index = this.open.length - 1;

    if (this.config.explorationStrategy !== 'dfs') {
      const compare =
        this.config.explorationStrategy === 'beam'
          ? (a: ThoughtNode, b: ThoughtNode) =>
              a.depth - b.depth || pendingFirst(a, b) || b.cumulativeScore - a.cumulativeScore
          : (a: ThoughtNode, b: ThoughtNode) =>
              branchScore(b) - branchScore(a) || pendingFirst(a, b);

      index = 0;
      for (let i = 1; i < this.open.length; i++) {
        if (compare(this.open[i], this.open[index]) < 0) index = i;
      }
    }

    const [node] = this.open.splice(index, 1);
    this.queued.delete(node.id);
    return node;
  }

  private buildNodePrompt(branch: ThoughtBranch, goal: string): string {
    const action = branch.proposedAction;

    if (action.type === 'tool_call') {
      return `Goal: ${goal}\n\nApproach: ${branch.thought}\n\nExecute this approach using the ${action.toolName} tool with arguments: ${JSON.stringify(action.arguments)}`;
    }

    if (action.type === 'sub_goal') {
      return `Goal: ${goal}\n\nApproach: ${branch.thought}\n\nWork on this sub-goal: ${action.goal}`;
    }

    return `Goal: ${goal}\n\nApproach: ${branch.thought}`;
  }

  private shouldTerminate(node: ThoughtNode): boolean {
    if (node.status === 'failed') return false;
    if (!node.branch.score) return false;

    return node.branch.score.confidence >= this.config.terminationConfidence;
  }

  private backtrack(from: ThoughtNode): void {
    from.status = 'failed';
    this.stats.backtrackCount++;

    let current = from;
    while (current.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;

      const alternative = parent.children
        .map((id) => this.nodes.get(id))
        .filter((n): n is ThoughtNode => n?.status === 'pending' && !this.queued.has(n.id))
        .sort((a, b) => b.cumulativeScore - a.cumulativeScore)[0];

      if (alternative) {
        this.enqueue([alternative]);
        this.config.onBacktrack?.(from, alternative);
        return;
      }

      current = parent;
    }

    this.config.onBacktrack?.(from, null);
  }

  private findBestNode(): ThoughtNode | null {
    let best: ThoughtNode | null = null;
    let bestScore = -Infinity;

    for (const node of this.nodes.values()) {
      if (node.status === 'completed' && node.cumulativeScore > bestScore) {
        best = node;
        bestScore = node.cumulativeScore;
      }
    }

    return best;
  }

  private getPathToNode(node: ThoughtNode): ThoughtNode[] {
    const path: ThoughtNode[] = [];
    let current: ThoughtNode | undefined = node;

    while (current) {
      path.unshift(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }

    return path;
  }

  private getExploredThoughts(): string[] {
    return Array.from(this.nodes.values())
      .filter((n) => n.status === 'completed' || n.status === 'exploring')
      .map((n) => n.branch.thought);
  }

  private async createResult(
    runId: string,
    goal: string,
    agentId: string,
    bestNode: ThoughtNode | null,
    startTime: number
  ): Promise<ToTResult> {
    const duration = Date.now() - startTime;
    this.stats.duration = duration;

    const bestPath = bestNode ? this.getPathToNode(bestNode) : [];
    let output = '';

    if (bestNode?.result?.response) {
      output = bestNode.result.response;
    } else if (bestPath.length > 0) {
      output = this.llm
        ? await this.synthesizeOutput(this.llm, goal, bestPath)
        : this.fallbackSynthesis(bestPath);
    }

    const root = this.nodes.values().next().value as ThoughtNode | undefined;

    const tree: ThoughtTree = {
      id: runId,
      goal,
      agentId,
      root: root ?? this.createRootNode(goal),
      nodes: new Map(this.nodes),
      bestPath: bestPath.map((n) => n.id),
      bestScore: bestNode?.cumulativeScore ?? 0,
      stats: { ...this.stats },
    };

    return {
      success: bestNode !== null && bestNode.status === 'completed',
      output,
      tree,
      bestPath,
      stats: { ...this.stats },
      runId,
      agentId,
      usage: {
        inputTokens: this.stats.tokenUsage.input,
        outputTokens: this.stats.tokenUsage.output,
        totalTokens: this.stats.tokenUsage.input + this.stats.tokenUsage.output,
        cost: this.cost,
        duration,
      },
    };
  }

  private async synthesizeOutput(
    llm: LLMBackend,
    goal: string,
    path: ThoughtNode[]
  ): Promise<string> {
    const prompt = buildSynthesisPrompt(goal, path);

    try {
      const response = await llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        maxTokens: 1000,
      });

      return response.content;
    } catch {
      return this.fallbackSynthesis(path);
    }
  }

  private fallbackSynthesis(path: ThoughtNode[]): string {
    if (path.length === 0) return 'No solution found.';

    const last = path[path.length - 1];
    if (last.result?.response) return last.result.response;

    return path
      .filter((n) => n.result?.response)
      .map((n) => n.result!.response)
      .join('\n\n');
  }

  private buildAgentContext(agent: Agent, goal: string, runId: string = ''): AgentContext {
    return {
      agentId: agent.id,
      agentName: agent.name,
      runId: runId || `tot_${nanoid(8)}`,
      threadId: `thread_${nanoid(8)}`,
      goal,
      iterationIndex: 0,
      availableTools: agent.tools.map((t) => t.name),
      previousActions: [],
    };
  }

  /**
   * Runs of a branch are capped at `maxIterationsPerBranch` iterations, or at
   * the agent's own `maxIterations` when that is lower.
   */
  private createBranchAgent(agent: Agent): Agent {
    const own = agent.config.maxIterations;
    const maxIterations = Math.min(own ?? Infinity, this.config.maxIterationsPerBranch);
    return maxIterations === own ? agent : agent.clone({ id: agent.id, maxIterations });
  }

  /** The executor's own model calls, counted into the stats, token usage and cost. */
  private trackUsage(backend: LLMBackend): LLMBackend {
    return {
      provider: backend.provider,
      chat: async (request) => {
        this.stats.llmCalls++;
        const response = await backend.chat(request);
        this.recordUsage(response.usage);
        return response;
      },
      chatStream: (request) => backend.chatStream(request),
    };
  }

  private recordUsage(usage: ChatUsage): void {
    this.stats.tokenUsage.input += usage.inputTokens;
    this.stats.tokenUsage.output += usage.outputTokens;
    this.cost += calculateCost(parseModel(this.modelString).model, usage) ?? 0;
  }

  private getReflectionEngine(): ReflectionEngine | undefined {
    return this.cogitator.reflectionEngine;
  }

  private createInitialStats(): ToTStats {
    return {
      totalNodes: 0,
      exploredNodes: 0,
      prunedNodes: 0,
      maxDepthReached: 0,
      backtrackCount: 0,
      duration: 0,
      llmCalls: 0,
      tokenUsage: { input: 0, output: 0 },
    };
  }
}
