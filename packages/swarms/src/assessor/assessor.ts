import { parseModel } from '@cogitator-ai/core';
import type {
  Agent,
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
  assessorModel: 'gpt-6-luna',
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

/**
 * Model string an agent can run with: `${provider}/${id}`.
 */
export function qualifiedModelId(model: Pick<DiscoveredModel, 'id' | 'provider'>): string {
  return model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`;
}

function findDiscoveredModel(
  models: DiscoveredModel[],
  modelString: string
): DiscoveredModel | undefined {
  return models.find((m) => m.id === modelString || qualifiedModelId(m) === modelString);
}

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

  /**
   * @param resolveModel - the model an agent runs on when it sets none, e.g.
   *   `(agent) => cogitator.resolveModel(agent)`
   */
  async analyze(
    task: string,
    swarmConfig: SwarmConfig,
    resolveModel: (agent: Agent) => string = requireOwnModel
  ): Promise<AssessmentResult> {
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
      const currentModel = resolveModel(agent.agent);
      if (agent.metadata.locked) {
        assignments.push({
          agentName: agent.agent.name,
          originalModel: currentModel,
          assignedModel: currentModel,
          provider: this.detectProvider(currentModel),
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
        const originalModel = currentModel;
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
        originalModel: currentModel,
        assignedModel: qualifiedModelId(selectedModel.model),
        provider: selectedModel.model.provider,
        score: selectedModel.score,
        reasons: selectedModel.reasons,
        fallbackModels: validModels
          .filter((s) => s !== selectedModel)
          .slice(0, 3)
          .map((s) => qualifiedModelId(s.model)),
        locked: false,
      });
    }

    if (this.config.maxCostPerRun) {
      this.optimizeForBudget(
        assignments,
        discoveredModels,
        this.config.maxCostPerRun,
        taskAnalysis.complexity,
        roleAnalyses
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

  /**
   * Apply assessment results: every unlocked agent is replaced by a clone running the
   * assigned model. Agents keep their name, instructions and tools.
   */
  assignModels(config: SwarmConfig, result: AssessmentResult): SwarmConfig {
    const assignments = new Map(
      result.assignments.filter((a) => !a.locked).map((a) => [a.agentName, a.assignedModel])
    );
    const clones = new Map<Agent, Agent>();

    const updateAgent = (agent: Agent): Agent => {
      const assignedModel = assignments.get(agent.name);
      if (!assignedModel || assignedModel === agent.model) return agent;

      let clone = clones.get(agent);
      if (!clone) {
        clone = agent.clone({ model: assignedModel, provider: undefined });
        clones.set(agent, clone);
      }
      return clone;
    };

    return {
      ...config,
      supervisor: config.supervisor && updateAgent(config.supervisor),
      workers: config.workers?.map(updateAgent),
      agents: config.agents?.map(updateAgent),
      moderator: config.moderator && updateAgent(config.moderator),
      router: config.router && updateAgent(config.router),
      stages: config.stages?.map((stage) => ({ ...stage, agent: updateAgent(stage.agent) })),
      pipeline: config.pipeline && {
        ...config.pipeline,
        stages: config.pipeline.stages.map((stage) => ({
          ...stage,
          agent: updateAgent(stage.agent),
        })),
      },
    };
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
        agents: this.roleMatcher
          .extractAgentsFromConfig(config)
          .map((a) => [a.agent.name, a.agent.model, a.metadata.role, a.metadata.locked ?? false]),
      })
    );
    return `${taskHash}-${configHash}`;
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private detectProvider(modelId: string): ModelProvider {
    const prefixed = parseModel(modelId).provider;
    if (prefixed && isModelProvider(prefixed)) return prefixed;

    const lower = modelId.toLowerCase();
    if (lower.startsWith('gpt') || /^o\d/.test(lower)) return 'openai';
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
      const model = findDiscoveredModel(discoveredModels, assignment.assignedModel);
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
    complexity: TaskComplexity = 'moderate',
    roleAnalyses?: Map<string, RoleRequirements>
  ): void {
    let currentCost = this.estimateTotalCost(assignments, discoveredModels, complexity);
    if (currentCost <= budget) return;

    const byExpense = [...assignments]
      .filter((a) => !a.locked)
      .map((a) => {
        const model = findDiscoveredModel(discoveredModels, a.assignedModel);
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
        const fallbackModel = findDiscoveredModel(discoveredModels, fallbackId);
        if (!fallbackModel) continue;

        const oldCost = item.model ? this.estimateModelCost(item.model, complexity) : 0;
        const newCost = this.estimateModelCost(fallbackModel, complexity);

        if (newCost >= oldCost) continue;

        item.assignment.fallbackModels = item.assignment.fallbackModels.filter(
          (id) => id !== fallbackId
        );
        if (item.model) {
          item.assignment.fallbackModels.unshift(qualifiedModelId(item.model));
        }
        item.assignment.assignedModel = fallbackId;
        item.assignment.provider = fallbackModel.provider;
        item.assignment.reasons.push('Downgraded for cost optimization');
        item.model = fallbackModel;

        const reqs = roleAnalyses?.get(item.assignment.agentName);
        if (reqs) {
          const rescored = this.modelScorer.score(fallbackModel, reqs);
          item.assignment.score = rescored.score;
        }

        currentCost -= oldCost - newCost;
        break;
      }
    }
  }
}

const MODEL_PROVIDERS: readonly ModelProvider[] = [
  'ollama',
  'openai',
  'anthropic',
  'google',
  'azure',
  'mistral',
];

function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function createAssessor(config?: AssessorConfig): SwarmAssessor {
  return new SwarmAssessor(config);
}

function requireOwnModel(agent: Agent): string {
  if (!agent.model) {
    throw new Error(
      `Agent "${agent.name}" has no model: set one, or pass a resolver such as cogitator.resolveModel`
    );
  }
  return agent.model;
}
