import type {
  LLMBackend,
  ThoughtBranch,
  BranchScore,
  AgentContext,
  ReflectionAction,
} from '@cogitator-ai/types';
import { ReflectionEngine } from '../reflection/index';
import { buildBranchEvaluationPrompt, parseEvaluationResponse } from './prompts';

export interface BranchEvaluatorOptions {
  llm: LLMBackend;
  model: string;
  reflectionEngine?: ReflectionEngine;
  confidenceWeight?: number;
  progressWeight?: number;
  noveltyWeight?: number;
}

export class BranchEvaluator {
  private llm: LLMBackend;
  private model: string;
  private reflectionEngine?: ReflectionEngine;
  private weights: { confidence: number; progress: number; novelty: number };

  constructor(options: BranchEvaluatorOptions) {
    this.llm = options.llm;
    this.model = options.model;
    this.reflectionEngine = options.reflectionEngine;
    this.weights = {
      confidence: options.confidenceWeight ?? 0.5,
      progress: options.progressWeight ?? 0.3,
      novelty: options.noveltyWeight ?? 0.2,
    };
  }

  async evaluate(
    branch: ThoughtBranch,
    goal: string,
    context: AgentContext,
    siblings: ThoughtBranch[] = []
  ): Promise<BranchScore> {
    if (this.reflectionEngine && branch.proposedAction.type === 'tool_call') {
      return this.evaluateWithReflection(branch, goal, context, siblings);
    }

    return this.evaluateWithLLM(branch, goal, siblings);
  }

  async evaluateBatch(
    branches: ThoughtBranch[],
    goal: string,
    context: AgentContext
  ): Promise<Map<string, BranchScore>> {
    const results = new Map<string, BranchScore>();

    const evaluations = await Promise.all(
      branches.map(branch =>
        this.evaluate(branch, goal, context, branches.filter(b => b.id !== branch.id))
      )
    );

    branches.forEach((branch, i) => {
      results.set(branch.id, evaluations[i]);
    });

    return results;
  }

  private async evaluateWithReflection(
    branch: ThoughtBranch,
    goal: string,
    context: AgentContext,
    siblings: ThoughtBranch[]
  ): Promise<BranchScore> {
    const action: ReflectionAction = {
      type: 'tool_call',
      toolName: branch.proposedAction.type === 'tool_call' ? branch.proposedAction.toolName : undefined,
      input: branch.proposedAction.type === 'tool_call' ? branch.proposedAction.arguments : undefined,
    };

    const reflectionContext: AgentContext = {
      ...context,
      goal: `Evaluate if "${branch.thought}" is a good approach for: ${goal}`,
    };

    const result = await this.reflectionEngine!.reflectOnToolCall(action, reflectionContext);
    const confidence = result.reflection.analysis.confidence;
    const progress = this.estimateProgress(branch, goal);
    const novelty = this.calculateNovelty(branch, siblings);

    return {
      confidence,
      progress,
      novelty,
      composite: this.calculateComposite(confidence, progress, novelty),
      reasoning: result.reflection.analysis.reasoning,
    };
  }

  private async evaluateWithLLM(
    branch: ThoughtBranch,
    goal: string,
    siblings: ThoughtBranch[]
  ): Promise<BranchScore> {
    const prompt = buildBranchEvaluationPrompt(branch, goal, siblings);

    const response = await this.llm.chat({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are an evaluation assistant. Assess approaches objectively. Always respond with valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      maxTokens: 500,
    });

    const parsed = parseEvaluationResponse(response.content);

    if (!parsed) {
      return this.createFallbackScore(branch, siblings);
    }

    return {
      confidence: parsed.confidence,
      progress: parsed.progress,
      novelty: parsed.novelty,
      composite: this.calculateComposite(parsed.confidence, parsed.progress, parsed.novelty),
      reasoning: parsed.reasoning,
    };
  }

  private estimateProgress(branch: ThoughtBranch, _goal: string): number {
    if (branch.proposedAction.type === 'response') {
      return 0.8;
    }

    if (branch.proposedAction.type === 'sub_goal') {
      return 0.3;
    }

    return 0.5;
  }

  private calculateNovelty(branch: ThoughtBranch, siblings: ThoughtBranch[]): number {
    if (siblings.length === 0) return 1.0;

    const branchKey = this.getActionKey(branch);
    const siblingKeys = siblings.map(s => this.getActionKey(s));

    const sameAction = siblingKeys.filter(k => k === branchKey).length;
    const similarThoughts = siblings.filter(s =>
      this.calculateSimilarity(branch.thought, s.thought) > 0.5
    ).length;

    const actionNovelty = 1 - (sameAction / siblings.length);
    const thoughtNovelty = 1 - (similarThoughts / siblings.length);

    return (actionNovelty + thoughtNovelty) / 2;
  }

  private getActionKey(branch: ThoughtBranch): string {
    const action = branch.proposedAction;
    if (action.type === 'tool_call') {
      return `tool:${action.toolName}`;
    }
    return action.type;
  }

  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    return overlap / Math.max(wordsA.size, wordsB.size);
  }

  private calculateComposite(confidence: number, progress: number, novelty: number): number {
    return (
      this.weights.confidence * confidence +
      this.weights.progress * progress +
      this.weights.novelty * novelty
    );
  }

  private createFallbackScore(branch: ThoughtBranch, siblings: ThoughtBranch[]): BranchScore {
    const novelty = this.calculateNovelty(branch, siblings);

    return {
      confidence: 0.5,
      progress: 0.3,
      novelty,
      composite: this.calculateComposite(0.5, 0.3, novelty),
      reasoning: 'Fallback evaluation - could not parse LLM response',
    };
  }
}
