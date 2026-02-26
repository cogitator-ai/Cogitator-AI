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
  TaskComplexity,
} from '@cogitator-ai/types';
import { TaskAnalyzer } from './task-analyzer';
import { ModelDiscovery } from './model-discovery';
import { ModelScorer } from './scoring';
import { RoleMatcher } from './role-matcher';

type ResolvedAssessorConfig = Omit<Required<AssessorConfig>, 'maxCostPerRun'> & {
  maxCostPerRun?: number;
};

const DEFAULT_CONFIG: ResolvedAssessorConfig = {
  mode: 'rules',
  assessorModel: 'gpt-4o-mini',
  preferLocal: true,
  minCapabilityMatch: 0.3,
  ollamaUrl: 'http://localhost:11434',
  enabledProviders: ['ollama', 'openai', 'anthropic', 'google'],
  cacheAssessments: true,
  cacheTTL: 5 * 60 * 1000,
};

const TOKEN_ESTIMATES: Record<TaskComplexity, number> = {
  simple: 500,
  moderate: 1500,
  complex: 4000,
};

export class SwarmAssessor implements Assessor {
  private config: ResolvedAssessorConfig;
  private taskAnalyzer: TaskAnalyzer;
  private modelDiscovery: ModelDiscovery;
  private modelScorer: ModelScorer;
  private roleMatcher: RoleMatcher;
  private assessmentCache = new Map<string, { result: AssessmentResult; timestamp: number }>();

  constructor(config: AssessorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

    const taskAnalysis = this.taskAnalyzer.analyze(task);

    const discoveredModels = await this.modelDiscovery.discoverAll();

    const agents = this.roleMatcher.extractAgentsFromConfig(swarmConfig);

    const roleAnalyses = new Map<string, RoleRequirements>();
    const assignments: ModelAssignment[] = [];
    const warnings: string[] = [];

    for (const agent of agents) {
      if (agent.metadata.locked) {
        assignments.push({
          agentName: agent.agent.name,
          originalModel: agent.agent.model,
          assignedModel: agent.agent.model,
          provider: this.detectProvider(agent.agent.model),
          score: 100,
          reasons: ['Model locked by configuration'],
          fallbackModels: [],
          locked: true,
        });
        continue;
      }

      const roleReqs = this.roleMatcher.analyzeRole(agent, taskAnalysis);
      roleAnalyses.set(agent.agent.name, roleReqs);

      const scoredModels = this.modelScorer.scoreAll(discoveredModels, roleReqs);
      const minScore = this.config.minCapabilityMatch * 100;
      const validModels = scoredModels.filter((s) => s.score >= minScore);

      if (validModels.length === 0) {
        const originalModel = agent.agent.model;
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

      let selectedModel = validModels[0];
      if (this.config.preferLocal) {
        const localModel = validModels.find((m) => m.model.isLocal);
        if (localModel && localModel.score >= selectedModel.score * 0.8) {
          selectedModel = localModel;
        }
      }

      assignments.push({
        agentName: agent.agent.name,
        originalModel: agent.agent.model,
        assignedModel: selectedModel.model.id,
        provider: selectedModel.model.provider,
        score: selectedModel.score,
        reasons: selectedModel.reasons,
        fallbackModels: validModels.slice(1, 4).map((s) => s.model.id),
        locked: false,
      });
    }

    if (this.config.maxCostPerRun) {
      this.optimizeForBudget(
        assignments,
        discoveredModels,
        this.config.maxCostPerRun,
        taskAnalysis.complexity
      );
    }

    const result: AssessmentResult = {
      taskAnalysis,
      roleAnalyses,
      assignments,
      totalEstimatedCost: this.estimateTotalCost(
        assignments,
        discoveredModels,
        taskAnalysis.complexity
      ),
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

      const updateAgent = <T extends { name: string }>(agent: T): T => {
        if (agent.name !== assignment.agentName) return agent;
        return { ...agent, model: assignment.assignedModel };
      };

      if (updatedConfig.supervisor) {
        updatedConfig.supervisor = updateAgent(updatedConfig.supervisor);
      }

      if (updatedConfig.moderator) {
        updatedConfig.moderator = updateAgent(updatedConfig.moderator);
      }

      if (updatedConfig.router) {
        updatedConfig.router = updateAgent(updatedConfig.router);
      }

      if (updatedConfig.workers) {
        updatedConfig.workers = updatedConfig.workers.map((w) => updateAgent(w));
      }

      if (updatedConfig.agents) {
        updatedConfig.agents = updatedConfig.agents.map((a) => updateAgent(a));
      }

      if (updatedConfig.stages) {
        updatedConfig.stages = updatedConfig.stages.map((stage) => ({
          ...stage,
          agent: updateAgent(stage.agent),
        }));
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
    const configHash = this.hashString(
      JSON.stringify({
        name: config.name,
        strategy: config.strategy,
        agents: this.getAgentNames(config),
      })
    );
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
    if (config.supervisor) names.push(config.supervisor.name);
    if (config.workers) names.push(...config.workers.map((w) => w.name));
    if (config.agents) names.push(...config.agents.map((a) => a.name));
    if (config.moderator) names.push(config.moderator.name);
    if (config.router) names.push(config.router.name);
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
    discoveredModels: DiscoveredModel[],
    complexity: TaskComplexity = 'moderate'
  ): number {
    const estimatedTokens = TOKEN_ESTIMATES[complexity];
    let total = 0;
    for (const assignment of assignments) {
      const model = discoveredModels.find((m) => m.id === assignment.assignedModel);
      if (model && !model.isLocal) {
        total +=
          (model.pricing.input * estimatedTokens + model.pricing.output * estimatedTokens) /
          1_000_000;
      }
    }
    return total;
  }

  private estimateModelCost(
    model: DiscoveredModel,
    complexity: TaskComplexity = 'moderate'
  ): number {
    if (model.isLocal) return 0;
    const estimatedTokens = TOKEN_ESTIMATES[complexity];
    return (
      (model.pricing.input * estimatedTokens + model.pricing.output * estimatedTokens) / 1_000_000
    );
  }

  private optimizeForBudget(
    assignments: ModelAssignment[],
    discoveredModels: DiscoveredModel[],
    budget: number,
    complexity: TaskComplexity = 'moderate'
  ): void {
    let currentCost = this.estimateTotalCost(assignments, discoveredModels, complexity);
    if (currentCost <= budget) return;

    const byExpense = [...assignments]
      .filter((a) => !a.locked)
      .map((a) => {
        const model = discoveredModels.find((m) => m.id === a.assignedModel);
        return {
          assignment: a,
          model,
          cost: model ? this.estimateModelCost(model, complexity) : 0,
        };
      })
      .sort((a, b) => b.cost - a.cost);

    for (const item of byExpense) {
      if (currentCost <= budget) break;

      for (const fallbackId of item.assignment.fallbackModels) {
        const fallbackModel = discoveredModels.find((m) => m.id === fallbackId);
        if (fallbackModel?.isLocal) {
          const oldCost = item.model ? this.estimateModelCost(item.model, complexity) : 0;
          const newCost = this.estimateModelCost(fallbackModel, complexity);

          item.assignment.assignedModel = fallbackId;
          item.assignment.provider = fallbackModel.provider;
          item.assignment.reasons.push('Downgraded for cost optimization');

          currentCost -= oldCost - newCost;
          break;
        }
      }
    }
  }
}

export function createAssessor(config?: AssessorConfig): SwarmAssessor {
  return new SwarmAssessor(config);
}
