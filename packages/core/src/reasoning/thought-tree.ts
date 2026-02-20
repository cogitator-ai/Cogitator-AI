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
  LLMBackend,
} from '@cogitator-ai/types';
import { DEFAULT_TOT_CONFIG } from '@cogitator-ai/types';
import type { Cogitator } from '../runtime';
import { BranchGenerator } from './branch-generator';
import { BranchEvaluator } from './branch-evaluator';
import { buildSynthesisPrompt } from './prompts';
import { ReflectionEngine } from '../reflection/index';

function generateId(): string {
  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
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
  private currentModel: string = '';

  private nodes = new Map<string, ThoughtNode>();
  private stats: ToTStats = this.createInitialStats();

  constructor(cogitator: Cogitator, config: Partial<ToTConfig> = {}) {
    this.cogitator = cogitator;
    this.config = { ...DEFAULT_TOT_CONFIG, ...config };
  }

  async explore(agent: Agent, goal: string, options: ToTRunOptions = {}): Promise<ToTResult> {
    const runId = `tot_${nanoid(12)}`;
    const startTime = Date.now();

    this.nodes.clear();
    this.stats = this.createInitialStats();

    const llm = await this.getLLMBackend(agent);
    this.cachedLLM = llm;
    this.currentModel = agent.model;

    this.branchGenerator = new BranchGenerator(llm, this.currentModel);
    this.branchEvaluator = new BranchEvaluator({
      llm,
      model: this.currentModel,
      reflectionEngine: this.getReflectionEngine(),
    });

    const context = this.buildAgentContext(agent, goal);

    const root = this.createRootNode(goal);
    this.nodes.set(root.id, root);

    let frontier: ThoughtNode[] = [root];
    let bestNode: ThoughtNode | null = null;
    let bestScore = -Infinity;

    const timeoutAt = options.timeout ? startTime + options.timeout : null;
    const abortSignal = options.abortSignal;

    while (frontier.length > 0) {
      if (abortSignal?.aborted) {
        break;
      }
      if (timeoutAt && Date.now() > timeoutAt) {
        break;
      }
      if (this.stats.totalNodes >= this.config.maxTotalNodes) {
        break;
      }

      const node = frontier.shift()!;
      node.status = 'exploring';
      node.exploredAt = Date.now();

      if (node.depth >= this.config.maxDepth) {
        node.status = 'pruned';
        this.stats.prunedNodes++;
        continue;
      }

      const branches = await this.branchGenerator.generate(
        node.depth === 0 ? null : node,
        goal,
        this.config.branchFactor,
        context,
        this.getExploredThoughts()
      );

      this.stats.llmCalls++;
      this.config.onBranchGenerated?.(node, branches);

      const scores = await this.branchEvaluator.evaluateBatch(branches, goal, context);
      this.stats.llmCalls++;

      for (const branch of branches) {
        const score = scores.get(branch.id);
        if (score) {
          branch.score = score;
          this.config.onBranchEvaluated?.(branch, score);
        }
      }

      const validBranches = branches
        .filter((b) => b.score && b.score.composite >= this.config.confidenceThreshold)
        .sort((a, b) => (b.score?.composite ?? 0) - (a.score?.composite ?? 0))
        .slice(0, this.config.beamWidth);

      if (validBranches.length === 0) {
        const backtrackTarget = this.backtrack(node);
        if (backtrackTarget) {
          frontier.unshift(backtrackTarget);
        }
        continue;
      }

      for (const branch of validBranches) {
        const childNode = await this.expandNode(branch, node, agent, goal);
        this.stats.exploredNodes++;
        this.config.onNodeExplored?.(childNode);

        if (childNode.cumulativeScore > bestScore) {
          bestScore = childNode.cumulativeScore;
          bestNode = childNode;
        }

        if (this.shouldTerminate(childNode)) {
          return this.createResult(runId, goal, agent.id, childNode, startTime);
        }

        if (childNode.status === 'completed') {
          frontier.push(childNode);
        } else if (childNode.status === 'failed') {
          const backtrackTarget = this.backtrack(childNode);
          if (backtrackTarget) {
            frontier.unshift(backtrackTarget);
          }
        }
      }

      frontier.sort((a, b) => b.cumulativeScore - a.cumulativeScore);
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

  private async expandNode(
    branch: ThoughtBranch,
    parent: ThoughtNode,
    agent: Agent,
    goal: string
  ): Promise<ThoughtNode> {
    const nodeId = generateId();
    const node: ThoughtNode = {
      id: nodeId,
      parentId: parent.id,
      depth: parent.depth + 1,
      branch: { ...branch, parentId: parent.id },
      messages: [...branch.messagesSnapshot],
      status: 'exploring',
      cumulativeScore: parent.cumulativeScore + (branch.score?.composite ?? 0),
      children: [],
      createdAt: Date.now(),
    };

    parent.children.push(nodeId);
    this.nodes.set(nodeId, node);
    this.stats.totalNodes++;
    this.stats.maxDepthReached = Math.max(this.stats.maxDepthReached, node.depth);

    if (branch.proposedAction.type === 'response') {
      node.result = { response: branch.proposedAction.content };
      node.status = 'completed';
      node.exploredAt = Date.now();
      return node;
    }

    const input = this.buildNodePrompt(branch, goal);

    try {
      const result = await this.cogitator.run(agent, {
        input,
        useMemory: false,
      });

      this.stats.tokenUsage.input += result.usage.inputTokens;
      this.stats.tokenUsage.output += result.usage.outputTokens;

      node.result = { response: result.output };
      node.messages = [...result.messages];
      node.status = 'completed';
      node.exploredAt = Date.now();
    } catch (error) {
      node.result = { error: error instanceof Error ? error.message : String(error) };
      node.status = 'failed';
      node.exploredAt = Date.now();
    }

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

  private backtrack(from: ThoughtNode): ThoughtNode | null {
    from.status = 'failed';
    this.stats.backtrackCount++;

    let current = from;
    while (current.parentId) {
      const parent = this.nodes.get(current.parentId);
      if (!parent) break;

      const unexplored = parent.children
        .map((id) => this.nodes.get(id))
        .filter(
          (n): n is ThoughtNode =>
            n?.status === 'pending' &&
            (n.branch.score?.composite ?? 0) >= this.config.confidenceThreshold
        )
        .sort((a, b) => (b.branch.score?.composite ?? 0) - (a.branch.score?.composite ?? 0));

      if (unexplored.length > 0) {
        this.config.onBacktrack?.(from, unexplored[0]);
        return unexplored[0];
      }

      current = parent;
    }

    this.config.onBacktrack?.(from, null);
    return null;
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
      const llm = await this.getLLMBackendFromCache();
      if (llm) {
        output = await this.synthesizeOutput(llm, goal, bestPath);
      } else {
        output = this.fallbackSynthesis(bestPath);
      }
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
        cost: 0,
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
        model: this.currentModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        maxTokens: 1000,
      });

      this.stats.llmCalls++;
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

  private async getLLMBackend(agent: Agent): Promise<LLMBackend> {
    return (this.cogitator as unknown as { getBackend(model: string): LLMBackend }).getBackend(
      agent.model
    );
  }

  private cachedLLM?: LLMBackend;
  private async getLLMBackendFromCache(): Promise<LLMBackend | undefined> {
    return this.cachedLLM;
  }

  private getReflectionEngine(): ReflectionEngine | undefined {
    return (this.cogitator as unknown as { reflectionEngine?: ReflectionEngine }).reflectionEngine;
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
