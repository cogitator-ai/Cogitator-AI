import { nanoid } from 'nanoid';
import type {
  Agent,
  AgentConfig,
  Tool,
  ToolCall,
  ToolCallMessage,
  LLMBackend,
  ChatResponse,
  SelfModifyingConfig,
  ToolSelfGenerationConfig,
  ToolSandboxConfig,
  ArchitectureEvolutionConfig,
  ModificationConstraintsConfig,
  ModificationConstraints,
  ArchitectureConfig,
  GeneratedTool,
  MetaObservation,
  MetaAssessment,
  MetaAdaptation,
  MetaTrigger,
  ModificationCheckpoint,
  AppliedModification,
  ModificationRequest,
  SelfModifyingEvent,
  SelfModifyingEventType,
  CapabilityGap,
  EvolutionMetrics,
  ReasoningMode,
  Message,
  ToolSchema,
  ToolContext,
} from '@cogitator-ai/types';
import { DEFAULT_META_REASONING_CONFIG } from '@cogitator-ai/types';

import { SelfModifyingEventEmitter } from './events';
import { GapAnalyzer, ToolGenerator, InMemoryGeneratedToolStore } from './tool-generation';
import { MetaReasoner, mergeModeProfiles, type MetaReasoningOverrides } from './meta-reasoning';
import { ParameterOptimizer, type OptimizationResult } from './architecture-evolution';
import {
  ModificationValidator,
  RollbackManager,
  DEFAULT_SAFETY_CONSTRAINTS,
  DEFAULT_CAPABILITY_CONSTRAINTS,
  DEFAULT_RESOURCE_CONSTRAINTS,
} from './constraints';

export interface SelfModifyingAgentConfig {
  enabled?: boolean;
  toolGeneration?: Partial<Omit<ToolSelfGenerationConfig, 'sandboxConfig'>> & {
    sandboxConfig?: Partial<ToolSandboxConfig>;
  };
  metaReasoning?: MetaReasoningOverrides;
  architectureEvolution?: Partial<ArchitectureEvolutionConfig>;
  constraints?: Partial<ModificationConstraintsConfig>;
}

export interface SelfModifyingAgentOptions {
  agent: Agent;
  llm: LLMBackend;
  config?: SelfModifyingAgentConfig;
  /** Additional or overriding constraint sets used to validate every self-modification. */
  modificationConstraints?: Partial<ModificationConstraints>;
  /** Models architecture evolution may switch to. Model changes are never proposed when empty. */
  availableModels?: string[];
}

export interface SelfModifyingEventDataMap {
  run_started: { input: string };
  run_completed: {
    success: boolean;
    toolsGenerated?: number;
    adaptationsMade?: number;
    error?: string;
  };
  tool_generation_started: { gap: CapabilityGap };
  tool_generation_completed: {
    toolId: string;
    name: string;
    success: boolean;
    iterations?: number;
    error?: string;
  };
  meta_assessment: { observation: MetaObservation; assessment: MetaAssessment };
  strategy_changed: { previousMode: ReasoningMode; newMode: ReasoningMode; reason: string };
  architecture_evolved: {
    success: boolean;
    candidateId?: string;
    changes?: ArchitectureConfig;
    metrics?: EvolutionMetrics;
    error?: string;
  };
  checkpoint_created: { checkpointId: string };
  rollback_performed: { checkpointId: string; reason: string };
}

export type TypedSelfModifyingEvent<K extends SelfModifyingEventType> = Omit<
  SelfModifyingEvent,
  'type' | 'data'
> & {
  type: K;
  data: SelfModifyingEventDataMap[K];
};

export interface RunContext {
  runId: string;
  input: string;
  startTime: number;
  tools: Tool[];
  currentConfig: ArchitectureConfig;
  generatedTools: GeneratedTool[];
  observations: MetaObservation[];
  adaptations: MetaAdaptation[];
  checkpoints: ModificationCheckpoint[];
  modificationsCount: number;
  appliedModifications: AppliedModification[];
  tokensUsed: number;
}

interface StepOptions {
  temperature: number;
  contextAdditions: string[];
}

interface StepResult {
  content: string;
  finishReason: ChatResponse['finishReason'];
  tokensUsed: number;
  toolCalls: number;
  toolErrors: number;
  complete: boolean;
}

interface ExecutionResult {
  output: string;
  confidence: number;
}

interface ToolCallOutcome {
  call: ToolCall;
  content: string;
  failed: boolean;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

function resolveModelName(agent: Agent, provider: string): string {
  const model = agent.model;
  if (!model) {
    throw new Error(`SelfModifyingAgent needs agent "${agent.name}" to set a model`);
  }
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}
const DEFAULT_MAX_TOOL_ROUNDS = 10;

export class SelfModifyingAgent {
  private readonly agent: Agent;
  private readonly llm: LLMBackend;
  private readonly modelName: string;
  private readonly config: SelfModifyingConfig;
  private readonly emitter = new SelfModifyingEventEmitter();
  private readonly listenerWrappers = new Map<
    SelfModifyingEventType,
    Map<(event: never) => void, (event: SelfModifyingEvent) => void>
  >();

  private readonly gapAnalyzer: GapAnalyzer;
  private readonly toolGenerator: ToolGenerator;
  private readonly toolStore: InMemoryGeneratedToolStore;
  private readonly metaReasoner: MetaReasoner;
  private readonly parameterOptimizer: ParameterOptimizer;
  private readonly modificationValidator: ModificationValidator;
  private readonly rollbackManager: RollbackManager;

  private currentContext: RunContext | null = null;
  private runQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SelfModifyingAgentOptions) {
    this.agent = options.agent;
    this.llm = options.llm;
    this.modelName = resolveModelName(options.agent, options.llm.provider);
    this.config = this.mergeConfig(options.config);

    const toolGenConfig = this.config.toolGeneration;
    const agentModel = this.modelName;
    this.gapAnalyzer = new GapAnalyzer({ llm: this.llm, config: toolGenConfig, model: agentModel });
    this.toolGenerator = new ToolGenerator({
      llm: this.llm,
      config: toolGenConfig,
      model: agentModel,
    });
    this.toolStore = new InMemoryGeneratedToolStore();

    this.metaReasoner = new MetaReasoner({
      llm: this.llm,
      model: agentModel,
      config: this.config.metaReasoning,
    });

    this.parameterOptimizer = new ParameterOptimizer({
      llm: this.llm,
      config: this.config.architectureEvolution,
      baseConfig: this.createBaseArchitectureConfig(),
      model: agentModel,
      availableModels: options.availableModels,
    });

    this.modificationValidator = new ModificationValidator({
      constraints: {
        safety: [...DEFAULT_SAFETY_CONSTRAINTS, ...(options.modificationConstraints?.safety ?? [])],
        capability: [
          ...DEFAULT_CAPABILITY_CONSTRAINTS,
          ...(options.modificationConstraints?.capability ?? []),
        ],
        resource: [
          ...DEFAULT_RESOURCE_CONSTRAINTS,
          ...(options.modificationConstraints?.resource ?? []),
        ],
        custom: options.modificationConstraints?.custom,
      },
    });

    this.rollbackManager = new RollbackManager({
      maxCheckpoints: 10,
    });
  }

  on<K extends SelfModifyingEventType>(
    event: K,
    handler: (event: TypedSelfModifyingEvent<K>) => void
  ): () => void {
    let wrappers = this.listenerWrappers.get(event);
    if (!wrappers) {
      wrappers = new Map();
      this.listenerWrappers.set(event, wrappers);
    }
    const existing = wrappers.get(handler);
    if (existing) this.emitter.off(event, existing);

    const wrapped = (e: SelfModifyingEvent) => handler(e as TypedSelfModifyingEvent<K>);
    wrappers.set(handler, wrapped);
    this.emitter.on(event, wrapped);
    return () => this.off(event, handler);
  }

  off<K extends SelfModifyingEventType>(
    event: K,
    handler: (event: TypedSelfModifyingEvent<K>) => void
  ): void {
    const wrappers = this.listenerWrappers.get(event);
    const wrapped = wrappers?.get(handler);
    if (!wrappers || !wrapped) return;
    this.emitter.off(event, wrapped);
    wrappers.delete(handler);
  }

  run(input: string): Promise<{
    output: string;
    toolsGenerated: GeneratedTool[];
    adaptationsMade: MetaAdaptation[];
    finalConfig: ArchitectureConfig;
  }> {
    const result = this.runQueue.then(() => this.executeRun(input));
    this.runQueue = result.catch(() => undefined);
    return result;
  }

  async generateTool(gap: CapabilityGap): Promise<GeneratedTool | null> {
    if (!this.config.toolGeneration.enabled) {
      return null;
    }

    return this.generateAndRegisterTool(gap, this.currentContext?.tools ?? this.getAgentTools());
  }

  async recordToolUsage(toolId: string, success: boolean, executionTime: number): Promise<void> {
    await this.toolStore.recordUsage({
      toolId,
      timestamp: new Date(),
      success,
      executionTime,
    });
  }

  getGeneratedTools(): Promise<GeneratedTool[]> {
    return this.toolStore.list({ status: 'active' });
  }

  async createCheckpoint(): Promise<ModificationCheckpoint | null> {
    const ctx = this.currentContext;
    if (!ctx) return null;

    const agentConfig: AgentConfig = {
      name: this.agent.name || 'agent',
      model: ctx.currentConfig.model,
      instructions: this.agent.instructions || '',
      temperature: ctx.currentConfig.temperature,
      maxTokens: ctx.currentConfig.maxTokens,
    };

    const checkpoint = await this.rollbackManager.createCheckpoint(
      this.agent.name || 'agent',
      agentConfig,
      ctx.tools,
      [...ctx.appliedModifications]
    );

    ctx.checkpoints.push(checkpoint);
    this.emit('checkpoint_created', ctx.runId, { checkpointId: checkpoint.id });

    return checkpoint;
  }

  async rollbackToCheckpoint(checkpointId: string, reason = 'Manual rollback'): Promise<boolean> {
    const checkpoint = await this.rollbackManager.getCheckpoint(checkpointId);
    const restored = await this.rollbackManager.rollbackTo(checkpointId);
    if (!checkpoint || !restored) return false;

    const ctx = this.currentContext;
    if (ctx) {
      ctx.tools = restored.tools;
      ctx.currentConfig = {
        ...ctx.currentConfig,
        model: restored.agentConfig.model ?? ctx.currentConfig.model,
        temperature: restored.agentConfig.temperature ?? ctx.currentConfig.temperature,
        maxTokens: restored.agentConfig.maxTokens ?? ctx.currentConfig.maxTokens,
      };
      ctx.appliedModifications = [...checkpoint.modifications];

      const restoredNames = new Set(restored.tools.map((t) => t.name));
      const discarded = ctx.generatedTools.filter((t) => !restoredNames.has(t.name));
      for (const tool of discarded) {
        await this.toolStore.deprecate(tool.id, `Rolled back to checkpoint ${checkpointId}`);
      }
      ctx.generatedTools = ctx.generatedTools.filter((t) => restoredNames.has(t.name));
    }

    this.emit('rollback_performed', ctx?.runId ?? 'manual', { checkpointId, reason });

    return true;
  }

  private async executeRun(input: string): Promise<{
    output: string;
    toolsGenerated: GeneratedTool[];
    adaptationsMade: MetaAdaptation[];
    finalConfig: ArchitectureConfig;
  }> {
    const runId = `run_${nanoid(12)}`;
    const selfModification = this.config.enabled;
    const tools = selfModification ? await this.loadAvailableTools() : this.getAgentTools();

    const ctx: RunContext = {
      runId,
      input,
      startTime: Date.now(),
      tools,
      currentConfig: this.createBaseArchitectureConfig(),
      generatedTools: [],
      observations: [],
      adaptations: [],
      checkpoints: [],
      modificationsCount: 0,
      appliedModifications: [],
      tokensUsed: 0,
    };
    this.currentContext = ctx;

    this.emit('run_started', runId, { input });

    let optimization: { result: OptimizationResult; candidateId: string } | null = null;

    try {
      if (
        selfModification &&
        this.config.constraints.enabled &&
        this.config.constraints.autoRollback
      ) {
        await this.createCheckpoint();
      }

      if (selfModification && this.config.architectureEvolution.enabled) {
        optimization = await this.optimizeArchitecture(ctx);
      }

      if (
        selfModification &&
        this.config.toolGeneration.enabled &&
        this.config.toolGeneration.autoGenerate
      ) {
        await this.analyzeAndGenerateTools(ctx);
      }

      const execution = await this.executeWithMetaReasoning(ctx, selfModification);

      await this.recordArchitectureOutcome(ctx, optimization, true, execution.confidence);

      const result = {
        output: execution.output,
        toolsGenerated: [...ctx.generatedTools],
        adaptationsMade: [...ctx.adaptations],
        finalConfig: { ...ctx.currentConfig },
      };

      this.emit('run_completed', runId, {
        success: true,
        toolsGenerated: result.toolsGenerated.length,
        adaptationsMade: result.adaptationsMade.length,
      });

      return result;
    } catch (error) {
      await this.recordArchitectureOutcome(ctx, optimization, false, 0).catch(() => undefined);

      if (
        selfModification &&
        this.config.constraints.enabled &&
        this.config.constraints.autoRollback
      ) {
        await this.autoRollback(ctx, 'Run failed');
      }

      this.emit('run_completed', runId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      this.metaReasoner.cleanupRun(runId);
      this.currentContext = null;
    }
  }

  private emit<K extends SelfModifyingEventType>(
    type: K,
    runId: string,
    data: SelfModifyingEventDataMap[K]
  ): void {
    void this.emitter.emit({
      type,
      runId,
      agentId: this.agent.id,
      timestamp: new Date(),
      data,
    });
  }

  private createBaseArchitectureConfig(): ArchitectureConfig {
    return {
      model: this.modelName,
      temperature: this.agent.config?.temperature ?? 0.7,
      maxTokens: this.agent.config?.maxTokens ?? 4096,
      toolStrategy: 'sequential',
      reflectionDepth: 0,
    };
  }

  private mergeConfig(partial?: SelfModifyingAgentConfig): SelfModifyingConfig {
    const defaults: SelfModifyingConfig = {
      enabled: true,
      toolGeneration: {
        enabled: true,
        autoGenerate: true,
        maxToolsPerSession: 3,
        minConfidenceForGeneration: 0.7,
        maxIterationsPerTool: 3,
        requireLLMValidation: true,
        sandboxConfig: {
          enabled: true,
          maxExecutionTime: 5000,
          maxMemory: 50 * 1024 * 1024,
          allowedModules: [],
          isolationLevel: 'strict',
        },
      },
      metaReasoning: { ...DEFAULT_META_REASONING_CONFIG },
      architectureEvolution: {
        enabled: true,
        strategy: { type: 'ucb', explorationConstant: 2 },
        maxCandidates: 10,
        evaluationWindow: 10,
        minEvaluationsBeforeEvolution: 3,
        adaptationThreshold: 0.1,
      },
      constraints: {
        enabled: true,
        autoRollback: true,
        rollbackWindow: 30000,
        maxModificationsPerRun: 10,
      },
    };

    if (!partial) return defaults;

    const defaultSandbox = defaults.toolGeneration.sandboxConfig ?? {
      enabled: true,
      maxExecutionTime: 5000,
      maxMemory: 50 * 1024 * 1024,
      allowedModules: [],
      isolationLevel: 'strict' as const,
    };

    return {
      enabled: partial.enabled ?? defaults.enabled,
      toolGeneration: {
        ...defaults.toolGeneration,
        ...partial.toolGeneration,
        sandboxConfig: { ...defaultSandbox, ...partial.toolGeneration?.sandboxConfig },
      },
      metaReasoning: {
        ...defaults.metaReasoning,
        ...partial.metaReasoning,
        modeProfiles: mergeModeProfiles(
          defaults.metaReasoning.modeProfiles,
          partial.metaReasoning?.modeProfiles
        ),
      },
      architectureEvolution: {
        ...defaults.architectureEvolution,
        ...partial.architectureEvolution,
        strategy: {
          ...defaults.architectureEvolution.strategy,
          ...partial.architectureEvolution?.strategy,
        },
      },
      constraints: { ...defaults.constraints, ...partial.constraints },
    };
  }

  private getAgentTools(): Tool[] {
    return [...(this.agent.tools ?? [])];
  }

  private async loadAvailableTools(): Promise<Tool[]> {
    const tools = this.getAgentTools();
    const names = new Set(tools.map((t) => t.name));
    const stored = await this.toolStore.list({ status: 'active' });

    for (const generated of stored) {
      if (names.has(generated.name)) continue;
      names.add(generated.name);
      tools.push(this.toolGenerator.createExecutableTool(generated));
    }

    return tools;
  }

  private async optimizeArchitecture(
    ctx: RunContext
  ): Promise<{ result: OptimizationResult; candidateId: string } | null> {
    try {
      const result = await this.parameterOptimizer.optimize(ctx.input);
      const candidate = result.candidate;
      if (!candidate) return null;

      const isNoop = Object.keys(candidate.config).length === 0;
      if (isNoop) {
        return { result, candidateId: candidate.id };
      }

      if (!result.shouldAdopt || !this.canApplyModification(ctx)) {
        return { result, candidateId: 'baseline' };
      }

      const valid = await this.validateModification(ctx, {
        type: 'config_change',
        target: 'architecture',
        changes: result.recommendedConfig,
        reason: result.reasoning,
        payload: { candidateId: candidate.id, changedKeys: Object.keys(candidate.config) },
      });

      if (!valid) {
        return { result, candidateId: 'baseline' };
      }

      ctx.currentConfig = { ...result.recommendedConfig };
      this.recordModification(ctx, 'config_change', {
        candidateId: candidate.id,
        config: result.recommendedConfig,
      });

      this.emit('architecture_evolved', ctx.runId, {
        success: true,
        candidateId: candidate.id,
        changes: result.recommendedConfig,
        metrics: result.metrics,
      });

      return { result, candidateId: candidate.id };
    } catch (error) {
      this.emit('architecture_evolved', ctx.runId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async recordArchitectureOutcome(
    ctx: RunContext,
    optimization: { result: OptimizationResult; candidateId: string } | null,
    success: boolean,
    quality: number
  ): Promise<void> {
    if (!optimization) return;

    await this.parameterOptimizer.recordOutcome(
      optimization.candidateId,
      optimization.result.taskProfile,
      {
        successRate: success ? 1 : 0,
        latency: Date.now() - ctx.startTime,
        tokenUsage: ctx.tokensUsed,
        qualityScore: quality,
      }
    );
  }

  private async analyzeAndGenerateTools(ctx: RunContext): Promise<void> {
    try {
      const analysis = await this.gapAnalyzer.analyze(ctx.input, ctx.tools);

      for (const gap of analysis.gaps) {
        if (ctx.generatedTools.length >= this.config.toolGeneration.maxToolsPerSession) break;
        if (!this.canApplyModification(ctx)) break;
        if (gap.confidence < this.config.toolGeneration.minConfidenceForGeneration) continue;

        const tool = await this.generateAndRegisterTool(gap, ctx.tools);
        if (!tool) continue;

        ctx.generatedTools.push(tool);
        ctx.tools.push(this.toolGenerator.createExecutableTool(tool));
        this.recordModification(ctx, 'tool_generation', { toolId: tool.id, name: tool.name });
      }
    } catch (error) {
      this.emit('tool_generation_completed', ctx.runId, {
        toolId: '',
        name: '',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async generateAndRegisterTool(
    gap: CapabilityGap,
    existingTools: Tool[]
  ): Promise<GeneratedTool | null> {
    const ctx = this.currentContext;
    const runId = ctx?.runId ?? 'manual';

    this.emit('tool_generation_started', runId, { gap });

    const result = await this.toolGenerator.generate(gap, existingTools);
    const generated = result.tool;

    if (!result.success || !generated) {
      this.emit('tool_generation_completed', runId, {
        toolId: generated?.id ?? '',
        name: generated?.name ?? gap.suggestedToolName,
        success: false,
        iterations: result.iterations,
        error: result.error,
      });
      return null;
    }

    const rejection = await this.checkGeneratedTool(generated, existingTools);
    if (rejection) {
      this.emit('tool_generation_completed', runId, {
        toolId: generated.id,
        name: generated.name,
        success: false,
        iterations: result.iterations,
        error: rejection,
      });
      return null;
    }

    const activeTool: GeneratedTool = { ...generated, status: 'active' };
    await this.toolStore.save(activeTool);
    const saved = (await this.toolStore.get(activeTool.id)) ?? activeTool;

    this.emit('tool_generation_completed', runId, {
      toolId: saved.id,
      name: saved.name,
      success: true,
      iterations: result.iterations,
    });

    return saved;
  }

  private async checkGeneratedTool(
    tool: GeneratedTool,
    existingTools: Tool[]
  ): Promise<string | null> {
    if (existingTools.some((t) => t.name === tool.name)) {
      return `A tool named "${tool.name}" already exists`;
    }

    const linesOfCode = tool.implementation.split('\n').length;
    const valid = await this.validateModification(this.currentContext, {
      type: 'tool_generation',
      target: tool.name,
      changes: { name: tool.name, implementation: tool.implementation },
      reason: `Generated tool for capability gap: ${tool.name}`,
      payload: {
        sandboxExecution: this.config.toolGeneration.sandboxConfig?.enabled ?? false,
        linesOfCode,
        complexity: linesOfCode,
        modificationDepth: 1,
      },
    });

    return valid ? null : 'Rejected by modification constraints';
  }

  private async executeWithMetaReasoning(
    ctx: RunContext,
    selfModification: boolean
  ): Promise<ExecutionResult> {
    const runId = ctx.runId;
    const metaEnabled = selfModification && this.config.metaReasoning.enabled;
    const maxAttempts = metaEnabled ? Math.max(1, this.config.metaReasoning.maxAdaptations + 1) : 1;
    const contextAdditions: string[] = [];
    let modeAdapted = false;
    let pendingAdaptation: { adaptation: MetaAdaptation; confidence: number } | null = null;

    if (metaEnabled) {
      const modeConfig = this.metaReasoner.initializeRun(runId);
      this.emit('strategy_changed', runId, {
        previousMode: this.config.metaReasoning.defaultMode,
        newMode: modeConfig.mode,
        reason: 'Initial mode selection',
      });
    }

    let step: StepResult | null = null;
    let confidence = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const temperature = modeAdapted
        ? this.metaReasoner.getCurrentConfig(runId).temperature
        : ctx.currentConfig.temperature;

      step = await this.executeAgentStep(ctx, { temperature, contextAdditions });
      ctx.tokensUsed += step.tokensUsed;
      confidence = this.stepConfidence(step);

      if (!metaEnabled) break;

      this.metaReasoner.recordConfidence(runId, confidence);

      if (pendingAdaptation) {
        this.metaReasoner.recordOutcome(runId, pendingAdaptation.adaptation.id, {
          improved: step.complete || confidence > pendingAdaptation.confidence,
          progressDelta: step.complete ? 1 : 0,
          confidenceDelta: confidence - pendingAdaptation.confidence,
        });
        pendingAdaptation = null;
      }

      if (step.complete || attempt === maxAttempts) break;

      const observation = this.metaReasoner.observe(
        {
          runId,
          iteration: attempt,
          goal: ctx.input,
          currentMode: this.metaReasoner.getCurrentMode(runId),
          tokensUsed: ctx.tokensUsed,
          timeElapsed: Date.now() - ctx.startTime,
          iterationsRemaining: maxAttempts - attempt,
          budgetRemaining: (maxAttempts - attempt) / maxAttempts,
        },
        []
      );
      ctx.observations.push(observation);

      if (!this.selectTrigger(runId, attempt, confidence, observation)) continue;

      const assessment = await this.metaReasoner.assess(observation);
      this.emit('meta_assessment', runId, { observation, assessment });

      if (!assessment.requiresAdaptation) continue;
      if (assessment.recommendation.action === 'abort') break;

      const adaptation = await this.metaReasoner.adapt(runId, assessment);
      if (!adaptation) continue;

      ctx.adaptations.push(adaptation);
      pendingAdaptation = { adaptation, confidence };

      if (adaptation.type === 'context_injection' && assessment.recommendation.contextAddition) {
        contextAdditions.push(assessment.recommendation.contextAddition);
      } else {
        modeAdapted = true;
      }

      this.emit('strategy_changed', runId, {
        previousMode: adaptation.previousMode ?? this.metaReasoner.getCurrentMode(runId),
        newMode: adaptation.newMode ?? this.metaReasoner.getCurrentMode(runId),
        reason: adaptation.reason ?? adaptation.type,
      });
    }

    return { output: step?.content ?? '', confidence };
  }

  private selectTrigger(
    runId: string,
    iteration: number,
    confidence: number,
    observation: MetaObservation
  ): MetaTrigger | null {
    const context = {
      iteration,
      confidence,
      progressDelta: observation.progressDelta,
      stagnationCount: observation.stagnationCount,
    };
    const candidates: MetaTrigger[] = [
      'on_failure',
      'on_low_confidence',
      'on_stagnation',
      'iteration_complete',
      'periodic',
    ];
    return candidates.find((t) => this.metaReasoner.shouldTrigger(runId, t, context)) ?? null;
  }

  private async executeAgentStep(ctx: RunContext, options: StepOptions): Promise<StepResult> {
    const toolMap = new Map<string, Tool>(ctx.tools.map((t) => [t.name, t]));
    const toolSchemas = this.buildToolSchemas(ctx.tools);
    const generatedIds = new Map(ctx.generatedTools.map((t) => [t.name, t.id]));
    for (const stored of await this.toolStore.list({ status: 'active' })) {
      if (!generatedIds.has(stored.name)) generatedIds.set(stored.name, stored.id);
    }

    const model = ctx.currentConfig.model;
    const maxTokens = ctx.currentConfig.maxTokens;
    const messages: Message[] = [
      ...(this.agent.instructions
        ? [{ role: 'system' as const, content: this.agent.instructions }]
        : []),
      ...options.contextAdditions.map((content) => ({ role: 'system' as const, content })),
      { role: 'user' as const, content: ctx.input },
    ];

    let tokensUsed = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let response: ChatResponse | null = null;

    const maxToolRounds = this.agent.config?.maxIterations ?? DEFAULT_MAX_TOOL_ROUNDS;
    for (let round = 0; round < maxToolRounds; round++) {
      response = await this.llm.chat({
        model,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        temperature: options.temperature,
        maxTokens,
      });
      tokensUsed += response.usage?.totalTokens ?? 0;

      if (response.finishReason !== 'tool_calls' || !response.toolCalls?.length) {
        break;
      }

      const assistantMessage: ToolCallMessage = {
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMessage);

      const outcomes = await this.executeToolCalls(ctx, response.toolCalls, toolMap, generatedIds);
      for (const outcome of outcomes) {
        toolCalls++;
        if (outcome.failed) toolErrors++;
        messages.push({
          role: 'tool',
          content: outcome.content,
          toolCallId: outcome.call.id,
          name: outcome.call.name,
        });
      }
      response = null;
    }

    if (!response) {
      response = await this.llm.chat({
        model,
        messages,
        temperature: options.temperature,
        maxTokens,
      });
      tokensUsed += response.usage?.totalTokens ?? 0;
    }

    let content = response.content;
    let finishReason = response.finishReason;

    for (let depth = 0; depth < ctx.currentConfig.reflectionDepth && content.trim(); depth++) {
      const reflection = await this.llm.chat({
        model,
        messages: [
          ...messages,
          { role: 'assistant', content },
          {
            role: 'user',
            content:
              'Review your previous answer for mistakes or omissions. Reply with the final, corrected answer only. If it is already correct, repeat it unchanged.',
          },
        ],
        temperature: options.temperature,
        maxTokens,
      });
      tokensUsed += reflection.usage?.totalTokens ?? 0;
      if (!reflection.content.trim() || reflection.finishReason === 'error') break;
      content = reflection.content;
      finishReason = reflection.finishReason;
    }

    return {
      content,
      finishReason,
      tokensUsed,
      toolCalls,
      toolErrors,
      complete: content.trim().length > 0 && finishReason !== 'length' && finishReason !== 'error',
    };
  }

  private async executeToolCalls(
    ctx: RunContext,
    calls: ToolCall[],
    toolMap: Map<string, Tool>,
    generatedIds: Map<string, string>
  ): Promise<ToolCallOutcome[]> {
    const strategy = ctx.currentConfig.toolStrategy;
    const parallel =
      strategy === 'parallel' ||
      (strategy === 'adaptive' && new Set(calls.map((c) => c.name)).size === calls.length);

    if (parallel) {
      return Promise.all(
        calls.map((call) => this.executeToolCall(ctx, call, toolMap, generatedIds))
      );
    }

    const outcomes: ToolCallOutcome[] = [];
    for (const call of calls) {
      outcomes.push(await this.executeToolCall(ctx, call, toolMap, generatedIds));
    }
    return outcomes;
  }

  private async executeToolCall(
    ctx: RunContext,
    call: ToolCall,
    toolMap: Map<string, Tool>,
    generatedIds: Map<string, string>
  ): Promise<ToolCallOutcome> {
    const t = toolMap.get(call.name);
    const startedAt = Date.now();
    let result: unknown;
    let error: string | undefined;

    if (!t) {
      error = `Tool "${call.name}" not found`;
    } else {
      const parsed = t.parameters.safeParse(call.arguments);
      if (!parsed.success) {
        error = `Invalid arguments for "${call.name}": ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`;
      } else {
        try {
          const toolContext: ToolContext = {
            agentId: this.agent.id ?? this.agent.name ?? 'self-modifying',
            runId: ctx.runId,
            signal: AbortSignal.timeout(t.timeout ?? DEFAULT_TOOL_TIMEOUT_MS),
          };
          result = await t.execute(parsed.data, toolContext);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const duration = Date.now() - startedAt;
    const generatedId = generatedIds.get(call.name);
    if (generatedId) {
      await this.toolStore.recordUsage({
        toolId: generatedId,
        timestamp: new Date(),
        success: error === undefined,
        executionTime: duration,
        error,
      });
    }

    if (this.config.enabled && this.config.metaReasoning.enabled) {
      this.metaReasoner.recordAction(ctx.runId, {
        type: 'tool_call',
        toolName: call.name,
        input: call.arguments,
        output: error === undefined ? result : undefined,
        error,
        duration,
        timestamp: startedAt,
      });
    }

    if (error !== undefined) {
      return { call, content: JSON.stringify({ error }), failed: true };
    }

    return {
      call,
      content: typeof result === 'string' ? result : (JSON.stringify(result) ?? 'null'),
      failed: false,
    };
  }

  private buildToolSchemas(tools: Tool[]): ToolSchema[] {
    return tools.map((t) =>
      typeof t.toJSON === 'function'
        ? t.toJSON()
        : {
            name: t.name,
            description: t.description,
            parameters: { type: 'object' as const, properties: {} },
          }
    );
  }

  private stepConfidence(step: StepResult): number {
    if (!step.complete) return 0.2;
    if (step.toolCalls > 0 && step.toolErrors > 0) {
      return step.toolErrors >= step.toolCalls ? 0.4 : 0.6;
    }
    return 0.9;
  }

  private async validateModification(
    ctx: RunContext | null,
    request: ModificationRequest
  ): Promise<boolean> {
    if (!this.config.constraints.enabled) return true;

    const validation = await this.modificationValidator.validate(request);

    if (validation.rollbackRequired && this.config.constraints.autoRollback && ctx) {
      await this.autoRollback(ctx, `Critical constraint violation: ${request.type}`);
    }

    return validation.valid;
  }

  private canApplyModification(ctx: RunContext): boolean {
    if (!this.config.constraints.enabled) return true;
    return ctx.modificationsCount < this.config.constraints.maxModificationsPerRun;
  }

  private recordModification(ctx: RunContext, type: string, data: unknown): void {
    ctx.modificationsCount++;
    ctx.appliedModifications.push({
      id: `mod_${nanoid(8)}`,
      type,
      appliedAt: new Date(),
      data,
    });
  }

  private async autoRollback(ctx: RunContext, reason: string): Promise<void> {
    const now = Date.now();
    const window = this.config.constraints.rollbackWindow;
    const target = ctx.checkpoints
      .filter((c) => now - c.timestamp.getTime() <= window)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    if (target) {
      await this.rollbackToCheckpoint(target.id, reason);
    }
  }
}
