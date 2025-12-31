import type {
  SwarmConfig,
  AssessorConfig,
  AssessmentResult,
  ModelAssignment,
  TaskRequirements,
  ModelCandidate,
  RoleRequirements,
  DiscoveredModel,
  Assessor,
  ModelProvider,
} from '@cogitator-ai/types';
import { TaskAnalyzer } from './task-analyzer';
import { ModelDiscovery } from './model-discovery';
import { ModelScorer } from './scoring';
import { RoleMatcher } from './role-matcher';

const DEFAULT_CONFIG: Required<AssessorConfig> = {
  mode: 'rules',
  assessorModel: 'gpt-4o-mini',
  preferLocal: true,
  maxCostPerRun: undefined as unknown as number,
  minCapabilityMatch: 0.3,
  ollamaUrl: 'http://localhost:11434',
  enabledProviders: ['ollama', 'openai', 'anthropic', 'google'],
  cacheAssessments: true,
  cacheTTL: 5 * 60 * 1000,
};

export class SwarmAssessor implements Assessor {
  private config: Required<AssessorConfig>;
  private taskAnalyzer: TaskAnalyzer;
  private modelDiscovery: ModelDiscovery;
  private modelScorer: ModelScorer;
  private roleMatcher: RoleMatcher;
  private assessmentCache: Map<string, { result: AssessmentResult; timestamp: number }> = new Map();

  constructor(config: AssessorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<AssessorConfig>;
    this.taskAnalyzer = new TaskAnalyzer();
    this.modelDiscovery = new ModelDiscovery(this.config);
    this.modelScorer = new ModelScorer();
    this.roleMatcher = new RoleMatcher();
  }

  async analyze(task: string, swarmConfig: SwarmConfig): Promise<AssessmentResult> {
    const cacheKey = this.getCacheKey(task, swarmConfig);
    if (this.config.cacheAssessments) {
      const cached = this.assessmentCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.config.cacheTTL) {
        return cached.result;
      }
    }

    // 1. Analyze task requirements
    const taskAnalysis = this.taskAnalyzer.analyze(task);

    // 2. Discover available models
    const discoveredModels = await this.modelDiscovery.discoverAll();

    // 3. Extract agents from swarm config
    const agents = this.roleMatcher.extractAgentsFromConfig(swarmConfig);

    // 4. Analyze each role and generate assignments
    const roleAnalyses = new Map<string, RoleRequirements>();
    const assignments: ModelAssignment[] = [];
    const warnings: string[] = [];

    for (const agent of agents) {
      // Check if model is locked
      if (agent.metadata.locked) {
        assignments.push({
          agentName: agent.agent.name,
          originalModel: (agent.agent as { model?: string }).model ?? 'unknown',
          assignedModel: (agent.agent as { model?: string }).model ?? 'unknown',
          provider: this.detectProvider((agent.agent as { model?: string }).model ?? ''),
          score: 100,
          reasons: ['Model locked by configuration'],
          fallbackModels: [],
          locked: true,
        });
        continue;
      }

      // Analyze role requirements
      const roleReqs = this.roleMatcher.analyzeRole(agent, taskAnalysis);
      roleAnalyses.set(agent.agent.name, roleReqs);

      // Score all available models for this role
      const scoredModels = this.modelScorer.scoreAll(discoveredModels, roleReqs);
      const minScore = this.config.minCapabilityMatch * 100;
      const validModels = scoredModels.filter((s) => s.score >= minScore);

      if (validModels.length === 0) {
        // Fallback to original model
        const originalModel = (agent.agent as { model?: string }).model ?? 'gpt-4o-mini';
        warnings.push(
          `No suitable model found for ${agent.agent.name}, keeping original: ${originalModel}`
        );
        assignments.push({
          agentName: agent.agent.name,
          originalModel,
          assignedModel: originalModel,
          provider: this.detectProvider(originalModel),
          score: 50,
          reasons: ['No better model found, using original'],
          fallbackModels: [],
          locked: false,
        });
        continue;
      }

      // Apply local preference if enabled
      let selectedModel = validModels[0];
      if (this.config.preferLocal) {
        const localModel = validModels.find((m) => m.model.isLocal);
        if (localModel && localModel.score >= selectedModel.score * 0.8) {
          selectedModel = localModel;
        }
      }

      assignments.push({
        agentName: agent.agent.name,
        originalModel: (agent.agent as { model?: string }).model ?? 'unknown',
        assignedModel: selectedModel.model.id,
        provider: selectedModel.model.provider,
        score: selectedModel.score,
        reasons: selectedModel.reasons,
        fallbackModels: validModels.slice(1, 4).map((s) => s.model.id),
        locked: false,
      });
    }

    // Apply cost optimization if budget is set
    if (this.config.maxCostPerRun) {
      this.optimizeForBudget(assignments, discoveredModels, this.config.maxCostPerRun);
    }

    const result: AssessmentResult = {
      taskAnalysis,
      roleAnalyses,
      assignments,
      totalEstimatedCost: this.estimateTotalCost(assignments, discoveredModels),
      warnings,
      discoveredModels,
    };

    if (this.config.cacheAssessments) {
      this.assessmentCache.set(cacheKey, { result, timestamp: Date.now() });
    }

    return result;
  }

  assignModels(config: SwarmConfig, result: AssessmentResult): SwarmConfig {
    const updatedConfig = { ...config };

    for (const assignment of result.assignments) {
      if (assignment.locked) continue;

      const updateAgent = <T extends { name: string; model?: string }>(
        agent: T | undefined
      ): T | undefined => {
        if (!agent || agent.name !== assignment.agentName) return agent;
        return { ...agent, model: assignment.assignedModel };
      };

      if (updatedConfig.supervisor) {
        updatedConfig.supervisor = updateAgent(updatedConfig.supervisor as { name: string; model?: string }) as typeof updatedConfig.supervisor;
      }

      if (updatedConfig.moderator) {
        updatedConfig.moderator = updateAgent(updatedConfig.moderator as { name: string; model?: string }) as typeof updatedConfig.moderator;
      }

      if (updatedConfig.router) {
        updatedConfig.router = updateAgent(updatedConfig.router as { name: string; model?: string }) as typeof updatedConfig.router;
      }

      if (updatedConfig.workers) {
        updatedConfig.workers = updatedConfig.workers.map(
          (w) => updateAgent(w as { name: string; model?: string }) ?? w
        ) as typeof updatedConfig.workers;
      }

      if (updatedConfig.agents) {
        updatedConfig.agents = updatedConfig.agents.map(
          (a) => updateAgent(a as { name: string; model?: string }) ?? a
        ) as typeof updatedConfig.agents;
      }

      if (updatedConfig.stages) {
        updatedConfig.stages = updatedConfig.stages.map((stage) => ({
          ...stage,
          agent: updateAgent(stage.agent as { name: string; model?: string }) ?? stage.agent,
        })) as typeof updatedConfig.stages;
      }
    }

    return updatedConfig;
  }

  async suggestModels(requirements: TaskRequirements): Promise<ModelCandidate[]> {
    const discoveredModels = await this.modelDiscovery.discoverAll();
    const roleReqs: RoleRequirements = {
      ...requirements,
      role: 'worker',
      agentName: '_suggestion',
    };

    const scoredModels = this.modelScorer.scoreAll(discoveredModels, roleReqs);

    return scoredModels.slice(0, 10).map((s) => ({
      modelId: s.model.id,
      provider: s.model.provider,
      score: s.score,
      reasons: s.reasons,
      isLocal: s.model.isLocal,
      estimatedCost: (s.model.pricing.input + s.model.pricing.output) / 2,
      capabilities: s.model.capabilities,
    }));
  }

  private getCacheKey(task: string, config: SwarmConfig): string {
    const taskHash = this.hashString(task.slice(0, 500));
    const configHash = this.hashString(JSON.stringify({
      name: config.name,
      strategy: config.strategy,
      agents: this.getAgentNames(config),
    }));
    return `${taskHash}-${configHash}`;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private getAgentNames(config: SwarmConfig): string[] {
    const names: string[] = [];
    if (config.supervisor) names.push((config.supervisor as { name: string }).name);
    if (config.workers) names.push(...config.workers.map((w) => (w as { name: string }).name));
    if (config.agents) names.push(...config.agents.map((a) => (a as { name: string }).name));
    if (config.moderator) names.push((config.moderator as { name: string }).name);
    if (config.router) names.push((config.router as { name: string }).name);
    return names;
  }

  private detectProvider(modelId: string): ModelProvider {
    const lower = modelId.toLowerCase();
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'openai';
    if (lower.includes('claude')) return 'anthropic';
    if (lower.includes('gemini')) return 'google';
    if (lower.includes('mistral') || lower.includes('mixtral')) return 'mistral';
    return 'ollama';
  }

  private estimateTotalCost(
    assignments: ModelAssignment[],
    discoveredModels: DiscoveredModel[]
  ): number {
    let total = 0;
    for (const assignment of assignments) {
      const model = discoveredModels.find((m) => m.id === assignment.assignedModel);
      if (model && !model.isLocal) {
        // Estimate ~1000 tokens per agent interaction
        const estimatedTokens = 1000;
        total += (model.pricing.input * estimatedTokens + model.pricing.output * estimatedTokens) / 1_000_000;
      }
    }
    return total;
  }

  private optimizeForBudget(
    assignments: ModelAssignment[],
    discoveredModels: DiscoveredModel[],
    budget: number
  ): void {
    let currentCost = this.estimateTotalCost(assignments, discoveredModels);
    if (currentCost <= budget) return;

    // Sort by cost (highest first) and try to downgrade
    const byExpense = [...assignments]
      .filter((a) => !a.locked)
      .map((a) => {
        const model = discoveredModels.find((m) => m.id === a.assignedModel);
        return { assignment: a, cost: model ? (model.pricing.input + model.pricing.output) / 2 : 0 };
      })
      .sort((a, b) => b.cost - a.cost);

    for (const item of byExpense) {
      if (currentCost <= budget) break;

      // Try fallback models
      for (const fallbackId of item.assignment.fallbackModels) {
        const fallbackModel = discoveredModels.find((m) => m.id === fallbackId);
        if (fallbackModel && fallbackModel.isLocal) {
          const oldModel = discoveredModels.find((m) => m.id === item.assignment.assignedModel);
          const oldCost = oldModel ? (oldModel.pricing.input + oldModel.pricing.output) / 2 : 0;

          item.assignment.assignedModel = fallbackId;
          item.assignment.provider = fallbackModel.provider;
          item.assignment.reasons.push('Downgraded for cost optimization');

          currentCost -= oldCost * 0.001; // Rough estimate
          break;
        }
      }
    }
  }
}

export function createAssessor(config?: AssessorConfig): SwarmAssessor {
  return new SwarmAssessor(config);
}
