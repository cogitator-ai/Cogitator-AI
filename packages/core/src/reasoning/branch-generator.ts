import type { LLMBackend, ThoughtNode, ThoughtBranch, AgentContext } from '@cogitator-ai/types';
import { buildBranchGenerationPrompt, parseBranchResponse } from './prompts';

function generateId(): string {
  return `branch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export class BranchGenerator {
  private llm: LLMBackend;
  private model: string;

  constructor(llm: LLMBackend, model: string) {
    this.llm = llm;
    this.model = model;
  }

  async generate(
    currentNode: ThoughtNode | null,
    goal: string,
    k: number,
    context: AgentContext,
    exploredThoughts: string[] = []
  ): Promise<ThoughtBranch[]> {
    const prompt = buildBranchGenerationPrompt(
      goal,
      currentNode,
      context.availableTools,
      k,
      exploredThoughts
    );

    const response = await this.llm.chat({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are a strategic reasoning assistant. Generate diverse approaches to solve problems. Always respond with valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.8,
      maxTokens: 2000,
    });

    const parsed = parseBranchResponse(response.content);

    if (!parsed || parsed.branches.length === 0) {
      return this.createFallbackBranches(goal, k, currentNode);
    }

    const parentId = currentNode?.id ?? null;
    const messagesSnapshot = currentNode?.messages ?? [];

    return parsed.branches.slice(0, k).map(b => ({
      id: generateId(),
      parentId,
      thought: b.thought,
      proposedAction: b.action,
      messagesSnapshot: [...messagesSnapshot],
    }));
  }

  private createFallbackBranches(
    goal: string,
    _k: number,
    currentNode: ThoughtNode | null
  ): ThoughtBranch[] {
    const parentId = currentNode?.id ?? null;
    const messagesSnapshot = currentNode?.messages ?? [];

    return [{
      id: generateId(),
      parentId,
      thought: `Attempting to directly address: ${goal}`,
      proposedAction: {
        type: 'response',
        content: `Let me work on: ${goal}`,
      },
      messagesSnapshot: [...messagesSnapshot],
    }];
  }
}
