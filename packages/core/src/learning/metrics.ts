import type {
  ExecutionTrace,
  MetricResult,
  MetricFn,
  MetricEvaluatorConfig,
  BuiltinMetric,
  LLMBackend,
} from '@cogitator-ai/types';

export interface MetricEvaluatorOptions {
  llm?: LLMBackend;
  model?: string;
  config?: Partial<MetricEvaluatorConfig>;
}

const DEFAULT_CONFIG: MetricEvaluatorConfig = {
  metrics: [
    {
      name: 'success',
      type: 'boolean',
      description: 'Did the run complete without errors?',
      weight: 0.4,
    },
    {
      name: 'tool_accuracy',
      type: 'numeric',
      description: 'Did tools produce expected results?',
      weight: 0.3,
    },
    { name: 'efficiency', type: 'numeric', description: 'Token/time efficiency', weight: 0.3 },
  ],
  aggregation: 'weighted-average',
  passThreshold: 0.7,
};

export class MetricEvaluator {
  private llm?: LLMBackend;
  private model?: string;
  private config: MetricEvaluatorConfig;
  private customMetrics = new Map<string, MetricFn>();

  constructor(options: MetricEvaluatorOptions = {}) {
    this.llm = options.llm;
    this.model = options.model;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
  }

  registerMetric(name: string, fn: MetricFn): void {
    this.customMetrics.set(name, fn);
  }

  async evaluate(
    trace: ExecutionTrace,
    expected?: unknown
  ): Promise<{ results: MetricResult[]; score: number; passed: boolean }> {
    const results: MetricResult[] = [];

    for (const metricDef of this.config.metrics) {
      const result = await this.evaluateMetric(metricDef.name, trace, expected);
      results.push(result);
    }

    const score = this.aggregateScores(results);
    const passed = score >= this.config.passThreshold;

    return { results, score, passed };
  }

  async evaluateBatch(
    traces: ExecutionTrace[],
    expectedList?: unknown[]
  ): Promise<Map<string, { results: MetricResult[]; score: number; passed: boolean }>> {
    const results = new Map<string, { results: MetricResult[]; score: number; passed: boolean }>();

    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      const expected = expectedList?.[i];
      const evaluation = await this.evaluate(trace, expected);
      results.set(trace.id, evaluation);
    }

    return results;
  }

  private async evaluateMetric(
    name: string,
    trace: ExecutionTrace,
    expected?: unknown
  ): Promise<MetricResult> {
    if (this.customMetrics.has(name)) {
      const fn = this.customMetrics.get(name)!;
      return fn(trace, expected);
    }

    switch (name as BuiltinMetric) {
      case 'success':
        return this.successMetric(trace);
      case 'tool_accuracy':
        return this.toolAccuracyMetric(trace, expected);
      case 'efficiency':
        return this.efficiencyMetric(trace);
      case 'completeness':
        return this.completenessMetric(trace, expected);
      case 'coherence':
        return this.coherenceMetric(trace);
      default:
        return { name, value: 0.5, passed: true, reasoning: 'Unknown metric' };
    }
  }

  successMetric(trace: ExecutionTrace): MetricResult {
    const hasErrors = trace.steps.some(
      (step) =>
        step.toolResult?.error ||
        (step.type === 'reflection' && step.reflection?.analysis?.wasSuccessful === false)
    );

    const value = hasErrors ? 0 : 1;

    return {
      name: 'success',
      value,
      passed: value === 1,
      reasoning: hasErrors
        ? 'Run had errors or failed reflections'
        : 'Run completed without errors',
    };
  }

  toolAccuracyMetric(trace: ExecutionTrace, expected?: unknown): MetricResult {
    const toolSteps = trace.steps.filter((s) => s.type === 'tool_call');

    if (toolSteps.length === 0) {
      return {
        name: 'tool_accuracy',
        value: 1,
        passed: true,
        reasoning: 'No tool calls to evaluate',
      };
    }

    let successfulCalls = 0;
    for (const step of toolSteps) {
      if (step.toolResult && !step.toolResult.error) {
        successfulCalls++;
      }
    }

    const value = successfulCalls / toolSteps.length;

    if (expected !== undefined && typeof expected === 'string') {
      const outputMatches = trace.output.toLowerCase().includes(expected.toString().toLowerCase());
      const adjustedValue = outputMatches ? Math.min(value + 0.2, 1) : Math.max(value - 0.2, 0);
      return {
        name: 'tool_accuracy',
        value: adjustedValue,
        passed: adjustedValue >= 0.7,
        reasoning: `${successfulCalls}/${toolSteps.length} successful tool calls, output ${outputMatches ? 'matches' : 'does not match'} expected`,
      };
    }

    return {
      name: 'tool_accuracy',
      value,
      passed: value >= 0.7,
      reasoning: `${successfulCalls}/${toolSteps.length} successful tool calls`,
    };
  }

  efficiencyMetric(trace: ExecutionTrace): MetricResult {
    const totalTokens = trace.usage.inputTokens + trace.usage.outputTokens;
    const duration = trace.duration;

    const tokenEfficiency = Math.min(1, 10000 / Math.max(totalTokens, 1));
    const timeEfficiency = Math.min(1, 30000 / Math.max(duration, 1));

    const value = tokenEfficiency * 0.6 + timeEfficiency * 0.4;

    return {
      name: 'efficiency',
      value,
      passed: value >= 0.5,
      reasoning: `${totalTokens} tokens in ${duration}ms`,
    };
  }

  async completenessMetric(trace: ExecutionTrace, expected?: unknown): Promise<MetricResult> {
    if (!this.llm || !this.model) {
      const hasOutput = !!trace.output && trace.output.length > 10;
      return {
        name: 'completeness',
        value: hasOutput ? 0.7 : 0.3,
        passed: hasOutput,
        reasoning: 'Basic output length check (no LLM available)',
      };
    }

    const prompt = `Evaluate how completely this output addresses the input.

Input: ${trace.input}
Output: ${trace.output}
${expected ? `Expected: ${JSON.stringify(expected)}` : ''}

Rate completeness from 0.0 to 1.0 where:
- 0.0 = completely misses the point
- 0.5 = partially addresses input
- 1.0 = fully and thoroughly addresses input

Respond with JSON: { "score": 0.X, "reasoning": "..." }`;

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 200,
      });

      const parsed = this.parseMetricResponse(response.content);
      return {
        name: 'completeness',
        value: parsed.score,
        passed: parsed.score >= 0.7,
        reasoning: parsed.reasoning,
      };
    } catch {
      return {
        name: 'completeness',
        value: 0.5,
        passed: true,
        reasoning: 'Evaluation failed, using default',
      };
    }
  }

  async coherenceMetric(trace: ExecutionTrace): Promise<MetricResult> {
    if (!this.llm || !this.model) {
      return {
        name: 'coherence',
        value: 0.7,
        passed: true,
        reasoning: 'No LLM available for coherence check',
      };
    }

    const prompt = `Evaluate the logical coherence of this agent execution.

Input: ${trace.input}
Steps taken: ${trace.steps.map((s) => (s.type === 'tool_call' ? `Tool: ${s.toolCall?.name}` : s.type)).join(' → ')}
Output: ${trace.output}

Rate coherence from 0.0 to 1.0 where:
- 0.0 = completely incoherent, steps don't make sense
- 0.5 = somewhat logical but with issues
- 1.0 = perfectly logical and well-structured

Respond with JSON: { "score": 0.X, "reasoning": "..." }`;

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        maxTokens: 200,
      });

      const parsed = this.parseMetricResponse(response.content);
      return {
        name: 'coherence',
        value: parsed.score,
        passed: parsed.score >= 0.6,
        reasoning: parsed.reasoning,
      };
    } catch {
      return {
        name: 'coherence',
        value: 0.6,
        passed: true,
        reasoning: 'Evaluation failed, using default',
      };
    }
  }

  private parseMetricResponse(content: string): { score: number; reasoning: string } {
    try {
      let jsonStr = content;
      const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(content);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1];
      }

      const parsed = JSON.parse(jsonStr);
      const score = Math.max(0, Math.min(1, Number(parsed.score) || 0.5));
      const reasoning = String(parsed.reasoning || 'No reasoning provided');

      return { score, reasoning };
    } catch {
      return { score: 0.5, reasoning: 'Failed to parse metric response' };
    }
  }

  private aggregateScores(results: MetricResult[]): number {
    if (results.length === 0) return 0;

    switch (this.config.aggregation) {
      case 'weighted-average': {
        let totalWeight = 0;
        let weightedSum = 0;

        for (const result of results) {
          const metricDef = this.config.metrics.find((m) => m.name === result.name);
          const weight = metricDef?.weight ?? 1;
          weightedSum += result.value * weight;
          totalWeight += weight;
        }

        return totalWeight > 0 ? weightedSum / totalWeight : 0;
      }

      case 'min':
        return Math.min(...results.map((r) => r.value));

      case 'product':
        return results.reduce((acc, r) => acc * r.value, 1);

      default:
        return results.reduce((sum, r) => sum + r.value, 0) / results.length;
    }
  }

  getConfig(): MetricEvaluatorConfig {
    return { ...this.config };
  }
}

export function createSuccessMetric(): MetricFn {
  return (trace: ExecutionTrace) => {
    const hasErrors = trace.steps.some((step) => step.toolResult?.error);
    return {
      name: 'success',
      value: hasErrors ? 0 : 1,
      passed: !hasErrors,
    };
  };
}

export function createExactMatchMetric(fieldPath?: string): MetricFn {
  return (trace: ExecutionTrace, expected?: unknown) => {
    if (expected === undefined) {
      return { name: 'exact_match', value: 1, passed: true, reasoning: 'No expected value' };
    }

    const outputValue = fieldPath ? trace.output : trace.output;

    const matches =
      String(outputValue).toLowerCase().trim() === String(expected).toLowerCase().trim();

    return {
      name: 'exact_match',
      value: matches ? 1 : 0,
      passed: matches,
      reasoning: matches ? 'Output matches expected' : 'Output does not match expected',
    };
  };
}

export function createContainsMetric(keywords: string[]): MetricFn {
  return (trace: ExecutionTrace) => {
    const outputLower = trace.output.toLowerCase();
    let found = 0;

    for (const keyword of keywords) {
      if (outputLower.includes(keyword.toLowerCase())) {
        found++;
      }
    }

    const value = keywords.length > 0 ? found / keywords.length : 1;

    return {
      name: 'contains',
      value,
      passed: value >= 0.5,
      reasoning: `Found ${found}/${keywords.length} keywords`,
    };
  };
}
