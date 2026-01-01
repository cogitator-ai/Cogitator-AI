import type {
  Agent,
  AgentConfig,
  Tool,
  LLMBackend,
  SelfModifyingConfig,
  ArchitectureConfig,
  GeneratedTool,
  MetaObservation,
  MetaAdaptation,
  ModificationCheckpoint,
  SelfModifyingEvent,
  CapabilityGap,
} from '@cogitator-ai/types';

import { SelfModifyingEventEmitter } from './events';
import { GapAnalyzer, ToolGenerator, InMemoryGeneratedToolStore } from './tool-generation';
import { MetaReasoner } from './meta-reasoning';
import { ParameterOptimizer, CapabilityAnalyzer } from './architecture-evolution';
import {
  ModificationValidator,
  RollbackManager,
  DEFAULT_SAFETY_CONSTRAINTS,
  DEFAULT_CAPABILITY_CONSTRAINTS,
  DEFAULT_RESOURCE_CONSTRAINTS,
} from './constraints';

export interface SelfModifyingAgentOptions {
  agent: Agent;
  llm: LLMBackend;
  config?: Partial<SelfModifyingConfig>;
}

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
}

export class SelfModifyingAgent {
  private readonly agent: Agent;
  private readonly llm: LLMBackend;
  private readonly config: SelfModifyingConfig;
  private readonly emitter = new SelfModifyingEventEmitter();

  private readonly gapAnalyzer: GapAnalyzer;
  private readonly toolGenerator: ToolGenerator;
  private readonly toolStore: InMemoryGeneratedToolStore;
  private readonly metaReasoner: MetaReasoner;
  private readonly parameterOptimizer: ParameterOptimizer;
  private readonly _capabilityAnalyzer: CapabilityAnalyzer;
  private readonly modificationValidator: ModificationValidator;
  private readonly rollbackManager: RollbackManager;

  private currentContext: RunContext | null = null;
  private isInitialized = false;

  constructor(options: SelfModifyingAgentOptions) {
    this.agent = options.agent;
    this.llm = options.llm;
    this.config = this.mergeConfig(options.config);

    const toolGenConfig = this.config.toolGeneration;
    this.gapAnalyzer = new GapAnalyzer({ llm: this.llm, config: toolGenConfig });
    this.toolGenerator = new ToolGenerator({ llm: this.llm, config: toolGenConfig });
    this.toolStore = new InMemoryGeneratedToolStore();

    this.metaReasoner = new MetaReasoner({
      llm: this.llm,
      model: 'default',
      config: this.config.metaReasoning,
    });

    const baseArchConfig: ArchitectureConfig = {
      model: 'default',
      temperature: 0.7,
      maxTokens: 4096,
      toolStrategy: 'sequential',
      reflectionDepth: 1,
    };

    this.parameterOptimizer = new ParameterOptimizer({
      llm: this.llm,
      config: this.config.architectureEvolution,
      baseConfig: baseArchConfig,
    });

    this._capabilityAnalyzer = new CapabilityAnalyzer({
      llm: this.llm,
      enableLLMAnalysis: true,
    });

    this.modificationValidator = new ModificationValidator({
      constraints: {
        safety: DEFAULT_SAFETY_CONSTRAINTS,
        capability: DEFAULT_CAPABILITY_CONSTRAINTS,
        resource: DEFAULT_RESOURCE_CONSTRAINTS,
      },
    });

    this.rollbackManager = new RollbackManager({
      maxCheckpoints: 10,
    });
  }

  on<K extends SelfModifyingEvent['type']>(
    event: K,
    handler: (event: Extract<SelfModifyingEvent, { type: K }>) => void
  ): void {
    this.emitter.on(event, handler as (event: SelfModifyingEvent) => void);
  }

  off<K extends SelfModifyingEvent['type']>(
    event: K,
    handler: (event: Extract<SelfModifyingEvent, { type: K }>) => void
  ): void {
    this.emitter.off(event, handler as (event: SelfModifyingEvent) => void);
  }

  async run(input: string): Promise<{
    output: string;
    toolsGenerated: GeneratedTool[];
    adaptationsMade: MetaAdaptation[];
    finalConfig: ArchitectureConfig;
  }> {
    await this.ensureInitialized();

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tools = this.getAvailableTools();

    const baseConfig: ArchitectureConfig = {
      model: 'default',
      temperature: 0.7,
      maxTokens: 4096,
      toolStrategy: 'sequential',
      reflectionDepth: 1,
    };

    this.currentContext = {
      runId,
      input,
      startTime: Date.now(),
      tools: [...tools],
      currentConfig: baseConfig,
      generatedTools: [],
      observations: [],
      adaptations: [],
      checkpoints: [],
    };

    this.emitter.emit({
      type: 'run_started',
      runId,
      timestamp: new Date(),
      data: { input },
    });

    try {
      if (this.config.architectureEvolution.enabled) {
        await this.optimizeArchitecture(input);
      }

      if (this.config.toolGeneration.enabled && this.config.toolGeneration.autoGenerate) {
        await this.analyzeAndGenerateTools(input);
      }

      const modeConfig = this.metaReasoner.initializeRun(runId);

      this.emitter.emit({
        type: 'strategy_changed',
        runId,
        timestamp: new Date(),
        data: {
          previousMode: 'analytical',
          newMode: modeConfig.mode,
          reason: 'Initial mode selection',
        },
      });

      const output = await this.executeWithMetaReasoning(input, runId);

      const result = {
        output,
        toolsGenerated: [...this.currentContext.generatedTools],
        adaptationsMade: [...this.currentContext.adaptations],
        finalConfig: { ...this.currentContext.currentConfig },
      };

      this.emitter.emit({
        type: 'run_completed',
        runId,
        timestamp: new Date(),
        data: {
          success: true,
          toolsGenerated: result.toolsGenerated.length,
          adaptationsMade: result.adaptationsMade.length,
        },
      });

      return result;
    } catch (error) {
      this.emitter.emit({
        type: 'run_completed',
        runId,
        timestamp: new Date(),
        data: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      throw error;
    } finally {
      this.currentContext = null;
    }
  }

  async generateTool(gap: CapabilityGap): Promise<GeneratedTool | null> {
    if (!this.config.toolGeneration.enabled) {
      return null;
    }

    const tools = this.getAvailableTools();
    const result = await this.toolGenerator.generate(gap, tools);

    if (result.success && result.tool) {
      await this.toolStore.save(result.tool);

      this.emitter.emit({
        type: 'tool_generation_completed',
        runId: this.currentContext?.runId || 'manual',
        timestamp: new Date(),
        data: {
          toolId: result.tool.id,
          name: result.tool.name,
          success: true,
          iterations: result.iterations,
        },
      });

      return result.tool;
    }

    this.emitter.emit({
      type: 'tool_generation_completed',
      runId: this.currentContext?.runId || 'manual',
      timestamp: new Date(),
      data: {
        toolId: '',
        name: gap.suggestedToolName,
        success: false,
        error: result.error,
      },
    });

    return null;
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
    if (!this.currentContext) return null;

    const agentConfig: AgentConfig = {
      name: this.agent.name || 'agent',
      model: this.currentContext.currentConfig.model,
      instructions: this.agent.instructions || '',
      temperature: this.currentContext.currentConfig.temperature,
      maxTokens: this.currentContext.currentConfig.maxTokens,
    };

    const checkpoint = await this.rollbackManager.createCheckpoint(
      this.agent.name || 'agent',
      agentConfig,
      this.currentContext.tools,
      []
    );

    this.currentContext.checkpoints.push(checkpoint);

    this.emitter.emit({
      type: 'checkpoint_created',
      runId: this.currentContext.runId,
      timestamp: new Date(),
      data: { checkpointId: checkpoint.id },
    });

    return checkpoint;
  }

  async rollbackToCheckpoint(checkpointId: string): Promise<boolean> {
    const restored = await this.rollbackManager.rollbackTo(checkpointId);
    if (!restored) return false;

    if (this.currentContext) {
      this.currentContext.tools = restored.tools;
    }

    this.emitter.emit({
      type: 'rollback_performed',
      runId: this.currentContext?.runId || 'manual',
      timestamp: new Date(),
      data: {
        checkpointId,
        reason: 'Manual rollback',
      },
    });

    return true;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    const activeToos = await this.toolStore.list({ status: 'active' });
    for (const tool of activeToos) {
      if (tool.validationScore && tool.validationScore > 0.8) {
      }
    }

    this.isInitialized = true;
  }

  private mergeConfig(partial?: Partial<SelfModifyingConfig>): SelfModifyingConfig {
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
      metaReasoning: {
        enabled: true,
        defaultMode: 'analytical',
        allowedModes: [
          'analytical',
          'creative',
          'systematic',
          'intuitive',
          'reflective',
          'exploratory',
        ],
        modeProfiles: {
          analytical: { mode: 'analytical', temperature: 0.3, depth: 3 },
          creative: { mode: 'creative', temperature: 0.9, depth: 2 },
          systematic: { mode: 'systematic', temperature: 0.2, depth: 4 },
          intuitive: { mode: 'intuitive', temperature: 0.6, depth: 1 },
          reflective: { mode: 'reflective', temperature: 0.4, depth: 3 },
          exploratory: { mode: 'exploratory', temperature: 0.7, depth: 2 },
        },
        maxAssessmentsPerRun: 5,
        maxAdaptationsPerRun: 3,
        maxMetaAssessments: 5,
        maxAdaptations: 3,
        assessmentCooldown: 10000,
        metaAssessmentCooldown: 10000,
        adaptationCooldown: 15000,
        triggers: ['on_failure', 'on_low_confidence', 'periodic'],
        triggerAfterIterations: 3,
        triggerOnConfidenceDrop: 0.3,
        triggerOnProgressStall: 2,
        tokenBudget: 2000,
        maxMetaTokens: 1000,
        minConfidenceToAdapt: 0.6,
        enableRollback: true,
        rollbackWindow: 30000,
        rollbackOnDecline: true,
      },
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

    return {
      enabled: partial.enabled ?? defaults.enabled,
      toolGeneration: { ...defaults.toolGeneration, ...partial.toolGeneration },
      metaReasoning: { ...defaults.metaReasoning, ...partial.metaReasoning },
      architectureEvolution: {
        ...defaults.architectureEvolution,
        ...partial.architectureEvolution,
      },
      constraints: { ...defaults.constraints, ...partial.constraints },
    };
  }

  private getAvailableTools(): Tool[] {
    return [];
  }

  private async optimizeArchitecture(input: string): Promise<void> {
    if (!this.currentContext) return;

    try {
      const result = await this.parameterOptimizer.optimize(input);

      if (result.shouldAdopt && result.confidence > 0.6) {
        const validation = await this.modificationValidator.validate({
          type: 'config_change',
          target: 'architecture',
          changes: result.recommendedConfig,
          reason: result.reasoning,
        });

        if (validation.valid) {
          this.currentContext.currentConfig = result.recommendedConfig;

          this.emitter.emit({
            type: 'architecture_evolved',
            runId: this.currentContext.runId,
            timestamp: new Date(),
            data: {
              candidateId: result.candidate?.id,
              changes: result.recommendedConfig,
              metrics: result.metrics,
            },
          });
        }
      }
    } catch {}
  }

  private async analyzeAndGenerateTools(input: string): Promise<void> {
    if (!this.currentContext) return;

    try {
      const analysis = await this.gapAnalyzer.analyze(input, this.currentContext.tools);

      for (const gap of analysis.gaps) {
        if (gap.confidence >= this.config.toolGeneration.minConfidenceForGeneration) {
          this.emitter.emit({
            type: 'tool_generation_started',
            runId: this.currentContext.runId,
            timestamp: new Date(),
            data: { gap },
          });

          const tool = await this.generateTool(gap);

          if (tool) {
            this.currentContext.generatedTools.push(tool);
            const executableTool = this.toolGenerator.createExecutableTool(tool);
            this.currentContext.tools.push(executableTool);
          }
        }
      }
    } catch {}
  }

  private async executeWithMetaReasoning(input: string, runId: string): Promise<string> {
    if (!this.currentContext) {
      throw new Error('No active run context');
    }

    let output = '';
    let iteration = 0;
    const maxIterations = 10;

    while (iteration < maxIterations) {
      iteration++;

      const currentMode = this.metaReasoner.getCurrentMode(runId);
      const observation = this.metaReasoner.observe(
        {
          runId,
          iteration,
          goal: input,
          currentMode,
          tokensUsed: Math.round(output.length * 1.3),
          timeElapsed: Date.now() - this.currentContext.startTime,
          iterationsRemaining: maxIterations - iteration,
          budgetRemaining: 10000 - Math.round(output.length * 1.3),
        },
        []
      );

      this.currentContext.observations.push(observation);

      if (
        this.metaReasoner.shouldTrigger(runId, 'periodic', {
          iteration,
          confidence: this.estimateConfidence(output),
          progressDelta: output.length > 0 ? 0.1 : 0,
          stagnationCount: 0,
        })
      ) {
        const assessment = await this.metaReasoner.assess(observation);

        this.emitter.emit({
          type: 'meta_assessment',
          runId,
          timestamp: new Date(),
          data: {
            observation,
            assessment,
          },
        });

        if (assessment.requiresAdaptation) {
          const adaptation = await this.metaReasoner.adapt(runId, assessment);

          if (adaptation) {
            this.currentContext.adaptations.push(adaptation);

            this.emitter.emit({
              type: 'strategy_changed',
              runId,
              timestamp: new Date(),
              data: {
                previousMode: adaptation.before?.mode || 'analytical',
                newMode: adaptation.after?.mode || 'analytical',
                reason: adaptation.type,
              },
            });
          }
        }
      }

      output = await this.executeAgentStep(input);

      if (this.isTaskComplete(output)) {
        break;
      }
    }

    return output;
  }

  private async executeAgentStep(input: string): Promise<string> {
    return `Processed: ${input}`;
  }

  private estimateConfidence(output: string): number {
    if (!output) return 0.3;
    if (output.length < 50) return 0.4;
    if (output.length < 200) return 0.6;
    return 0.8;
  }

  private isTaskComplete(output: string): boolean {
    return output.length > 0;
  }
}
