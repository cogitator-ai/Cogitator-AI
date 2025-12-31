import { nanoid } from 'nanoid';
import type { Demo, DemoStep, DemoStats, ExecutionTrace, TraceStore } from '@cogitator-ai/types';

export interface DemoSelectorOptions {
  traceStore: TraceStore;
  maxDemos?: number;
  minScore?: number;
  diversityWeight?: number;
}

export class DemoSelector {
  private traceStore: TraceStore;
  private demos = new Map<string, Demo>();
  private agentDemos = new Map<string, Set<string>>();
  private maxDemos: number;
  private minScore: number;

  constructor(options: DemoSelectorOptions) {
    this.traceStore = options.traceStore;
    this.maxDemos = options.maxDemos ?? 10;
    this.minScore = options.minScore ?? 0.8;
  }

  async selectDemos(agentId: string, input: string, limit: number): Promise<Demo[]> {
    const agentDemoIds = this.agentDemos.get(agentId);
    if (!agentDemoIds || agentDemoIds.size === 0) {
      return [];
    }

    const demos: Demo[] = [];
    for (const id of agentDemoIds) {
      const demo = this.demos.get(id);
      if (demo) demos.push(demo);
    }

    const inputLower = input.toLowerCase();
    const inputWords = new Set(inputLower.split(/\s+/).filter((w) => w.length > 3));

    const scored = demos.map((demo) => {
      const relevance = this.calculateRelevance(inputWords, demo);
      const quality = demo.score;
      const usage = Math.min(demo.usageCount * 0.1, 0.5);

      const score = relevance * 0.4 + quality * 0.4 + usage * 0.2;

      return { demo, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const selected = this.diversifySelection(
      scored.map((s) => s.demo),
      limit
    );

    for (const demo of selected) {
      demo.usageCount++;
      demo.lastUsedAt = new Date();
    }

    return selected;
  }

  async addDemo(trace: ExecutionTrace): Promise<Demo> {
    if (trace.score < this.minScore) {
      throw new Error(`Trace score ${trace.score} below minimum ${this.minScore}`);
    }

    const demo: Demo = {
      id: `demo_${nanoid(12)}`,
      agentId: trace.agentId,
      traceId: trace.id,
      input: trace.input,
      output: trace.output,
      keySteps: this.extractKeySteps(trace),
      score: trace.score,
      metrics: trace.metrics,
      usageCount: 0,
      lastUsedAt: new Date(),
      createdAt: new Date(),
      labels: trace.labels,
      context: this.extractContext(trace),
    };

    this.demos.set(demo.id, demo);

    let agentDemoIds = this.agentDemos.get(trace.agentId);
    if (!agentDemoIds) {
      agentDemoIds = new Set();
      this.agentDemos.set(trace.agentId, agentDemoIds);
    }
    agentDemoIds.add(demo.id);

    await this.traceStore.markAsDemo(trace.id);

    if (agentDemoIds.size > this.maxDemos) {
      await this.pruneLowestScoring(trace.agentId);
    }

    return demo;
  }

  async removeDemo(id: string): Promise<void> {
    const demo = this.demos.get(id);
    if (!demo) return;

    this.demos.delete(id);
    this.agentDemos.get(demo.agentId)?.delete(id);

    await this.traceStore.unmarkAsDemo(demo.traceId);
  }

  async getDemoStats(agentId: string): Promise<DemoStats> {
    const agentDemoIds = this.agentDemos.get(agentId);

    if (!agentDemoIds || agentDemoIds.size === 0) {
      return {
        totalDemos: 0,
        averageScore: 0,
        usageDistribution: [],
        coverageGaps: [],
      };
    }

    const demos: Demo[] = [];
    for (const id of agentDemoIds) {
      const demo = this.demos.get(id);
      if (demo) demos.push(demo);
    }

    const totalScore = demos.reduce((sum, d) => sum + d.score, 0);
    const averageScore = totalScore / demos.length;

    const usageDistribution = demos
      .map((d) => ({ demoId: d.id, count: d.usageCount }))
      .sort((a, b) => b.count - a.count);

    const unusedDemos = demos.filter((d) => d.usageCount === 0);
    const coverageGaps =
      unusedDemos.length > 0
        ? ['Some demos have never been used - may indicate coverage gaps']
        : [];

    return {
      totalDemos: demos.length,
      averageScore,
      usageDistribution,
      coverageGaps,
    };
  }

  getDemo(id: string): Demo | null {
    return this.demos.get(id) ?? null;
  }

  getAllDemos(agentId: string): Demo[] {
    const agentDemoIds = this.agentDemos.get(agentId);
    if (!agentDemoIds) return [];

    const demos: Demo[] = [];
    for (const id of agentDemoIds) {
      const demo = this.demos.get(id);
      if (demo) demos.push(demo);
    }

    return demos.sort((a, b) => b.score - a.score);
  }

  private calculateRelevance(inputWords: Set<string>, demo: Demo): number {
    const demoText = `${demo.input} ${demo.output} ${demo.context ?? ''}`.toLowerCase();

    let matches = 0;
    for (const word of inputWords) {
      if (demoText.includes(word)) {
        matches++;
      }
    }

    return inputWords.size > 0 ? matches / inputWords.size : 0;
  }

  private diversifySelection(demos: Demo[], limit: number): Demo[] {
    if (demos.length <= limit) {
      return demos;
    }

    const selected: Demo[] = [];
    const remaining = [...demos];

    selected.push(remaining.shift()!);

    while (selected.length < limit && remaining.length > 0) {
      let bestIndex = 0;
      let bestDiversity = -1;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        let minSimilarity = 1;

        for (const existing of selected) {
          const similarity = this.calculateSimilarity(candidate, existing);
          minSimilarity = Math.min(minSimilarity, similarity);
        }

        const diversity = 1 - minSimilarity;
        if (diversity > bestDiversity) {
          bestDiversity = diversity;
          bestIndex = i;
        }
      }

      selected.push(remaining.splice(bestIndex, 1)[0]);
    }

    return selected;
  }

  private calculateSimilarity(a: Demo, b: Demo): number {
    const aWords = new Set(a.input.toLowerCase().split(/\s+/));
    const bWords = new Set(b.input.toLowerCase().split(/\s+/));

    let intersection = 0;
    for (const word of aWords) {
      if (bWords.has(word)) intersection++;
    }

    const union = aWords.size + bWords.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private extractKeySteps(trace: ExecutionTrace): DemoStep[] {
    const keySteps: DemoStep[] = [];

    for (const step of trace.steps) {
      if (step.type === 'tool_call' && step.toolCall) {
        keySteps.push({
          description: `Used ${step.toolCall.name} tool`,
          toolName: step.toolCall.name,
          toolInput: step.toolCall.arguments,
          toolOutput: step.toolResult?.result,
        });
      }
    }

    return keySteps.slice(0, 5);
  }

  private extractContext(trace: ExecutionTrace): string {
    const parts: string[] = [];

    if (trace.toolCalls.length > 0) {
      const tools = [...new Set(trace.toolCalls.map((t) => t.name))];
      parts.push(`Tools: ${tools.join(', ')}`);
    }

    if (trace.labels && trace.labels.length > 0) {
      parts.push(`Labels: ${trace.labels.join(', ')}`);
    }

    return parts.join('; ');
  }

  private async pruneLowestScoring(agentId: string): Promise<void> {
    const agentDemoIds = this.agentDemos.get(agentId);
    if (!agentDemoIds || agentDemoIds.size <= this.maxDemos) return;

    const demos: Demo[] = [];
    for (const id of agentDemoIds) {
      const demo = this.demos.get(id);
      if (demo) demos.push(demo);
    }

    demos.sort((a, b) => {
      const scoreA = a.score * 0.6 + Math.min(a.usageCount * 0.1, 0.4);
      const scoreB = b.score * 0.6 + Math.min(b.usageCount * 0.1, 0.4);
      return scoreB - scoreA;
    });

    const toRemove = demos.slice(this.maxDemos);
    for (const demo of toRemove) {
      await this.removeDemo(demo.id);
    }
  }

  formatDemosForPrompt(demos: Demo[]): string {
    if (demos.length === 0) return '';

    const formatted = demos.map((demo, i) => {
      const stepsStr =
        demo.keySteps.length > 0
          ? `\nSteps: ${demo.keySteps.map((s) => s.description).join(' → ')}`
          : '';

      return `Example ${i + 1}:
Input: ${demo.input}
Output: ${demo.output}${stepsStr}`;
    });

    return `\n\nHere are some examples of successful executions:\n\n${formatted.join('\n\n')}`;
  }
}
