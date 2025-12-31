import type {
  TraceDiff,
  StepDiff,
  StepDiffStatus,
  ExecutionStep,
  ExecutionTrace,
  TraceMetrics,
  TraceStore,
  ToolResult,
} from '@cogitator-ai/types';

export interface TraceComparatorOptions {
  traceStore: TraceStore;
}

export class TraceComparator {
  private traceStore: TraceStore;

  constructor(options: TraceComparatorOptions) {
    this.traceStore = options.traceStore;
  }

  async compare(traceId1: string, traceId2: string): Promise<TraceDiff> {
    const trace1 = await this.traceStore.get(traceId1);
    const trace2 = await this.traceStore.get(traceId2);

    if (!trace1) {
      throw new Error(`Trace not found: ${traceId1}`);
    }
    if (!trace2) {
      throw new Error(`Trace not found: ${traceId2}`);
    }

    return this.computeDiff(trace1, trace2);
  }

  computeDiff(trace1: ExecutionTrace, trace2: ExecutionTrace): TraceDiff {
    const stepDiffs = this.compareStepSequences(trace1.steps, trace2.steps);
    const divergencePoint = this.findDivergencePoint(trace1.steps, trace2.steps);

    const commonSteps = stepDiffs.filter(
      (d) => d.status === 'identical' || d.status === 'similar'
    ).length;

    const trace1OnlySteps = stepDiffs.filter((d) => d.status === 'only_in_1').length;
    const trace2OnlySteps = stepDiffs.filter((d) => d.status === 'only_in_2').length;

    const tokens1 = trace1.usage.inputTokens + trace1.usage.outputTokens;
    const tokens2 = trace2.usage.inputTokens + trace2.usage.outputTokens;

    return {
      trace1Id: trace1.id,
      trace2Id: trace2.id,
      stepDiffs,
      commonSteps,
      divergencePoint,
      trace1OnlySteps,
      trace2OnlySteps,
      metricsDiff: {
        success: {
          trace1: trace1.metrics.success,
          trace2: trace2.metrics.success,
        },
        score: {
          trace1: trace1.score,
          trace2: trace2.score,
          delta: trace2.score - trace1.score,
        },
        tokens: {
          trace1: tokens1,
          trace2: tokens2,
          delta: tokens2 - tokens1,
        },
        duration: {
          trace1: trace1.duration,
          trace2: trace2.duration,
          delta: trace2.duration - trace1.duration,
        },
      },
    };
  }

  findDivergencePoint(steps1: ExecutionStep[], steps2: ExecutionStep[]): number | undefined {
    const minLength = Math.min(steps1.length, steps2.length);

    for (let i = 0; i < minLength; i++) {
      const comparison = this.compareSteps(steps1[i], steps2[i]);
      if (comparison.status === 'different') {
        return i;
      }
    }

    if (steps1.length !== steps2.length) {
      return minLength;
    }

    return undefined;
  }

  compareSteps(step1: ExecutionStep, step2: ExecutionStep): StepDiff {
    const differences: string[] = [];

    if (step1.type !== step2.type) {
      differences.push(`Type: ${step1.type} → ${step2.type}`);
    }

    if (step1.type === 'tool_call' && step2.type === 'tool_call') {
      if (step1.toolCall?.name !== step2.toolCall?.name) {
        differences.push(`Tool: ${step1.toolCall?.name} → ${step2.toolCall?.name}`);
      }

      if (step1.toolCall && step2.toolCall) {
        const args1 = JSON.stringify(step1.toolCall.arguments);
        const args2 = JSON.stringify(step2.toolCall.arguments);
        if (args1 !== args2) {
          differences.push('Tool arguments differ');
        }
      }

      if (step1.toolResult && step2.toolResult) {
        const resultComparison = this.compareToolResults(step1.toolResult, step2.toolResult);
        if (!resultComparison.similar) {
          differences.push(...resultComparison.differences);
        }
      }
    }

    if (step1.type === 'llm_call' && step2.type === 'llm_call') {
      if (step1.response !== step2.response) {
        differences.push('LLM response differs');
      }
    }

    let status: StepDiffStatus;
    if (differences.length === 0) {
      status = 'identical';
    } else if (differences.length === 1 && differences[0] === 'LLM response differs') {
      status = 'similar';
    } else {
      status = 'different';
    }

    return {
      index: step1.index,
      status,
      step1,
      step2,
      differences: differences.length > 0 ? differences : undefined,
    };
  }

  compareToolResults(
    result1: ToolResult,
    result2: ToolResult
  ): { similar: boolean; differences: string[] } {
    const differences: string[] = [];

    if (result1.name !== result2.name) {
      differences.push(`Tool name: ${result1.name} → ${result2.name}`);
    }

    if (result1.error !== result2.error) {
      if (result1.error && !result2.error) {
        differences.push(`Error removed: ${result1.error}`);
      } else if (!result1.error && result2.error) {
        differences.push(`Error added: ${result2.error}`);
      } else {
        differences.push(`Error changed: ${result1.error} → ${result2.error}`);
      }
    }

    const resultStr1 = JSON.stringify(result1.result);
    const resultStr2 = JSON.stringify(result2.result);
    if (resultStr1 !== resultStr2) {
      differences.push('Result data differs');
    }

    return {
      similar: differences.length === 0,
      differences,
    };
  }

  compareMetrics(
    metrics1: TraceMetrics,
    metrics2: TraceMetrics
  ): Record<string, { value1: number; value2: number; delta: number }> {
    return {
      toolAccuracy: {
        value1: metrics1.toolAccuracy,
        value2: metrics2.toolAccuracy,
        delta: metrics2.toolAccuracy - metrics1.toolAccuracy,
      },
      efficiency: {
        value1: metrics1.efficiency,
        value2: metrics2.efficiency,
        delta: metrics2.efficiency - metrics1.efficiency,
      },
      completeness: {
        value1: metrics1.completeness,
        value2: metrics2.completeness,
        delta: metrics2.completeness - metrics1.completeness,
      },
    };
  }

  formatDiff(diff: TraceDiff): string {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════');
    lines.push('              TRACE COMPARISON              ');
    lines.push('═══════════════════════════════════════════');
    lines.push('');

    lines.push(`Trace 1: ${diff.trace1Id}`);
    lines.push(`Trace 2: ${diff.trace2Id}`);
    lines.push('');

    if (diff.divergencePoint !== undefined) {
      lines.push(`⚠ Traces diverged at step ${diff.divergencePoint}`);
    } else {
      lines.push('✓ Traces are identical');
    }
    lines.push('');

    lines.push('─── Summary ───');
    lines.push(`Common steps:     ${diff.commonSteps}`);
    lines.push(`Only in trace 1:  ${diff.trace1OnlySteps}`);
    lines.push(`Only in trace 2:  ${diff.trace2OnlySteps}`);
    lines.push('');

    lines.push('─── Metrics ───');
    lines.push(`Success:  ${diff.metricsDiff.success.trace1} → ${diff.metricsDiff.success.trace2}`);
    lines.push(
      `Score:    ${diff.metricsDiff.score.trace1.toFixed(3)} → ${diff.metricsDiff.score.trace2.toFixed(3)} (${this.formatDelta(diff.metricsDiff.score.delta)})`
    );
    lines.push(
      `Tokens:   ${diff.metricsDiff.tokens.trace1} → ${diff.metricsDiff.tokens.trace2} (${this.formatDelta(diff.metricsDiff.tokens.delta)})`
    );
    lines.push(
      `Duration: ${diff.metricsDiff.duration.trace1}ms → ${diff.metricsDiff.duration.trace2}ms (${this.formatDelta(diff.metricsDiff.duration.delta)}ms)`
    );
    lines.push('');

    if (diff.stepDiffs.some((d) => d.status !== 'identical')) {
      lines.push('─── Step Differences ───');
      for (const stepDiff of diff.stepDiffs) {
        if (stepDiff.status !== 'identical') {
          const icon = this.getStatusIcon(stepDiff.status);
          lines.push(`${icon} Step ${stepDiff.index}: ${stepDiff.status}`);
          if (stepDiff.differences) {
            for (const d of stepDiff.differences) {
              lines.push(`   └─ ${d}`);
            }
          }
        }
      }
    }

    lines.push('');
    lines.push('═══════════════════════════════════════════');

    return lines.join('\n');
  }

  private compareStepSequences(steps1: ExecutionStep[], steps2: ExecutionStep[]): StepDiff[] {
    const diffs: StepDiff[] = [];
    const maxLength = Math.max(steps1.length, steps2.length);

    for (let i = 0; i < maxLength; i++) {
      const step1 = steps1[i];
      const step2 = steps2[i];

      if (!step1) {
        diffs.push({
          index: i,
          status: 'only_in_2',
          step2,
        });
      } else if (!step2) {
        diffs.push({
          index: i,
          status: 'only_in_1',
          step1,
        });
      } else {
        diffs.push(this.compareSteps(step1, step2));
      }
    }

    return diffs;
  }

  private formatDelta(delta: number): string {
    if (delta > 0) return `+${delta}`;
    return String(delta);
  }

  private getStatusIcon(status: StepDiffStatus): string {
    switch (status) {
      case 'identical':
        return '✓';
      case 'similar':
        return '≈';
      case 'different':
        return '✗';
      case 'only_in_1':
        return '◀';
      case 'only_in_2':
        return '▶';
      default:
        return '?';
    }
  }
}
