/**
 * Base strategy class for swarm coordination
 */

import type {
  SwarmRunOptions,
  SwarmCoordinatorInterface,
  IStrategy,
  StrategyResult,
  RunResult,
} from '@cogitator-ai/types';

export abstract class BaseStrategy implements IStrategy {
  protected coordinator: SwarmCoordinatorInterface;

  constructor(coordinator: SwarmCoordinatorInterface) {
    this.coordinator = coordinator;
  }

  abstract execute(options: SwarmRunOptions): Promise<StrategyResult>;

  /**
   * Collect outputs from multiple agents running in parallel
   */
  protected async collectOutputs(
    agentNames: string[],
    input: string,
    context?: Record<string, unknown>
  ): Promise<Map<string, RunResult>> {
    return this.coordinator.runAgentsParallel(
      agentNames.map((name) => ({ name, input, context }))
    );
  }

  /**
   * Run agents sequentially
   */
  protected async runSequential(
    agents: { name: string; input: string | ((prevOutput?: string) => string); context?: Record<string, unknown> }[]
  ): Promise<Map<string, RunResult>> {
    const results = new Map<string, RunResult>();
    let prevOutput: string | undefined;

    for (const { name, input, context } of agents) {
      const actualInput = typeof input === 'function' ? input(prevOutput) : input;
      const result = await this.coordinator.runAgent(name, actualInput, context);
      results.set(name, result);
      prevOutput = result.output;
    }

    return results;
  }

  /**
   * Synthesize multiple agent outputs into a single string
   */
  protected synthesizeOutputs(
    results: Map<string, RunResult>,
    format: 'list' | 'sections' = 'sections'
  ): string {
    if (format === 'list') {
      return Array.from(results.entries())
        .map(([name, result]) => `- ${name}: ${result.output}`)
        .join('\n');
    }

    return Array.from(results.entries())
      .map(([name, result]) => `=== ${name} ===\n${result.output}`)
      .join('\n\n');
  }

  /**
   * Get the last output from a map of results
   */
  protected getLastOutput(results: Map<string, RunResult>): string {
    const entries = Array.from(results.entries());
    if (entries.length === 0) return '';
    return entries[entries.length - 1][1].output;
  }

  /**
   * Merge all results into a single usage summary
   */
  protected mergeUsage(
    results: Map<string, RunResult>
  ): RunResult['usage'] {
    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;
    let duration = 0;

    for (const result of results.values()) {
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      cost += result.usage.cost;
      duration += result.usage.duration;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost,
      duration,
    };
  }
}
