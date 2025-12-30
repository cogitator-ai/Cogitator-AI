/**
 * Pipeline strategy - Sequential stages with optional gates
 */

import type {
  SwarmRunOptions,
  StrategyResult,
  PipelineConfig,
  PipelineStage,
  PipelineContext,
  RunResult,
} from '@cogitator/types';
import { BaseStrategy } from './base';
import type { SwarmCoordinator } from '../coordinator.js';

export class PipelineStrategy extends BaseStrategy {
  private config: PipelineConfig;

  constructor(coordinator: SwarmCoordinator, config: PipelineConfig) {
    super(coordinator);
    this.config = config;

    if (!config.stages || config.stages.length === 0) {
      throw new Error('Pipeline strategy requires at least one stage');
    }
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const agentResults = new Map<string, RunResult>();
    const stageOutputs = new Map<string, unknown>();

    this.coordinator.blackboard.write('pipeline', {
      stages: this.config.stages.map(s => s.name),
      currentStage: 0,
      completed: [],
      failed: [],
    }, 'system');

    let currentInput: unknown = options.input;
    let stageIndex = 0;

    while (stageIndex < this.config.stages.length) {
      const stage = this.config.stages[stageIndex];

      this.coordinator.events.emit('pipeline:stage', {
        index: stageIndex,
        name: stage.name,
        total: this.config.stages.length,
      });

      const pipelineState = this.coordinator.blackboard.read<{
        completed: string[];
        failed: string[];
      }>('pipeline');
      this.coordinator.blackboard.write('pipeline', {
        ...pipelineState,
        currentStage: stageIndex,
        currentStageName: stage.name,
      }, 'system');

      const pipelineContext: PipelineContext = {
        input: options.input,
        stageIndex,
        stageName: stage.name,
        previousOutputs: stageOutputs,
      };

      const stageInput = this.config.stageInput
        ? this.config.stageInput(currentInput, stage, pipelineContext)
        : this.buildDefaultStageInput(currentInput, stage, pipelineContext);

      const stageContext = {
        ...options.context,
        pipelineContext: {
          stageIndex,
          stageName: stage.name,
          totalStages: this.config.stages.length,
          isFirstStage: stageIndex === 0,
          isLastStage: stageIndex === this.config.stages.length - 1,
          previousOutputs: Object.fromEntries(stageOutputs),
        },
        stageInstructions: this.buildStageInstructions(stage, stageIndex),
      };

      const result = await this.coordinator.runAgent(
        stage.agent.name,
        String(stageInput),
        stageContext
      );
      agentResults.set(stage.name, result);
      stageOutputs.set(stage.name, result.output);
      currentInput = result.output;

      const updatedState = this.coordinator.blackboard.read<{
        completed: string[];
        failed: string[];
      }>('pipeline');
      updatedState.completed.push(stage.name);
      this.coordinator.blackboard.write('pipeline', updatedState, 'system');

      if (stage.gate) {
        const gateResult = await this.checkGate(
          stage,
          result,
          stageIndex,
          agentResults,
          options
        );

        if (gateResult.action === 'abort') {
          throw new Error(`Pipeline aborted at gate '${stage.name}': ${gateResult.reason}`);
        }

        if (gateResult.action === 'retry-previous' && stageIndex > 0) {
          const state = this.coordinator.blackboard.read<{
            completed: string[];
            failed: string[];
          }>('pipeline');
          state.failed.push(stage.name);
          state.completed = state.completed.filter(s => s !== stage.name);
          this.coordinator.blackboard.write('pipeline', state, 'system');

          stageIndex = stageIndex - 1;
          currentInput = stageOutputs.get(this.config.stages[stageIndex - 1]?.name) ?? options.input;
          continue;
        }

        if (gateResult.action === 'goto' && gateResult.targetStage !== undefined) {
          stageIndex = gateResult.targetStage;
          continue;
        }

      }

      this.coordinator.events.emit('pipeline:stage:complete', {
        index: stageIndex,
        name: stage.name,
      });

      stageIndex++;
    }

    const lastStageName = this.config.stages[this.config.stages.length - 1].name;
    const finalOutput = stageOutputs.get(lastStageName) as string;

    return {
      output: finalOutput,
      agentResults,
      pipelineOutputs: stageOutputs,
    };
  }

  private buildDefaultStageInput(
    prevOutput: unknown,
    stage: PipelineStage,
    context: PipelineContext
  ): string {
    if (context.stageIndex === 0) {
      return String(prevOutput);
    }

    return `Previous stage output:\n${prevOutput}\n\nYour task as the ${stage.name} stage: Process and transform this input according to your role.`;
  }

  private buildStageInstructions(stage: PipelineStage, stageIndex: number): string {
    const isGate = stage.gate ? '\nThis stage acts as a QUALITY GATE. Your output will be validated before proceeding.' : '';

    return `
You are the "${stage.name}" stage in a processing pipeline.
Stage ${stageIndex + 1} of ${this.config.stages.length}.
${isGate}

Process the input according to your configured role and pass your output to the next stage.
Ensure your output is well-structured and ready for the next stage to consume.
`.trim();
  }

  private async checkGate(
    stage: PipelineStage,
    result: RunResult,
    _stageIndex: number,
    _agentResults: Map<string, RunResult>,
    _options: SwarmRunOptions
  ): Promise<{
    action: 'pass' | 'retry-previous' | 'abort' | 'skip' | 'goto';
    targetStage?: number;
    reason?: string;
  }> {
    const gateConfig = this.config.gates?.[stage.name];

    if (!gateConfig) {
      const output = String(result.output).toLowerCase();
      const hasError = output.includes('error') || output.includes('failed') || output.includes('cannot');

      if (hasError) {
        this.coordinator.events.emit('pipeline:gate:fail', {
          stage: stage.name,
          reason: 'Output contains error indicators',
        });
        return { action: 'skip', reason: 'Output contains error indicators' };
      }

      this.coordinator.events.emit('pipeline:gate:pass', { stage: stage.name });
      return { action: 'pass' };
    }

    let passed: boolean;
    try {
      passed = gateConfig.condition(result.output);
    } catch {
      passed = false;
    }

    if (passed) {
      this.coordinator.events.emit('pipeline:gate:pass', { stage: stage.name });
      return { action: 'pass' };
    }

    this.coordinator.events.emit('pipeline:gate:fail', {
      stage: stage.name,
      reason: 'Gate condition failed',
    });

    const onFail = gateConfig.onFail;

    if (onFail === 'abort') {
      return { action: 'abort', reason: 'Gate condition failed' };
    }

    if (onFail === 'skip') {
      return { action: 'skip', reason: 'Gate condition failed, skipping' };
    }

    if (onFail === 'retry-previous') {
      const retryCount = this.getRetryCount(stage.name, _agentResults);
      if (retryCount >= gateConfig.maxRetries) {
        return { action: 'abort', reason: `Max retries (${gateConfig.maxRetries}) exceeded` };
      }
      return { action: 'retry-previous' };
    }

    if (onFail.startsWith('goto:')) {
      const targetStageName = onFail.slice(5);
      const targetIndex = this.config.stages.findIndex(s => s.name === targetStageName);
      if (targetIndex >= 0) {
        return { action: 'goto', targetStage: targetIndex };
      }
      return { action: 'abort', reason: `Target stage '${targetStageName}' not found` };
    }

    return { action: 'pass' };
  }

  private getRetryCount(stageName: string, results: Map<string, RunResult>): number {
    let count = 0;
    for (const key of results.keys()) {
      if (key === stageName || key.startsWith(`${stageName}_retry`)) {
        count++;
      }
    }
    return count - 1;
  }
}
