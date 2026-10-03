import type Anthropic from '@anthropic-ai/sdk';
import type { ReasoningConfig, ReasoningEffort, ToolCall } from '@cogitator-ai/types';
import { z } from 'zod';
import {
  getClaudeEffortLevels,
  getClaudeThinkingMode,
  getClaudeThinkingOff,
  type ClaudeEffort,
} from './claude-models';

export interface ClaudeThinkingParams {
  thinking?: Anthropic.ThinkingConfigParam;
  effort?: ClaudeEffort;
  /** `max_tokens` for the request: a thinking budget is added on top of the answer's tokens */
  maxTokens: number;
  /** A thinking budget is on: sampling parameters and forced tool use are not accepted with it */
  budgetThinking: boolean;
}

const THINKING_BUDGETS: Readonly<Record<Exclude<ReasoningEffort, 'none'>, number>> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
};

const EFFORT_ORDER: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Anthropic request parameters for a provider-neutral `reasoning` config.
 *
 * Adaptive-thinking models get `thinking: { type: 'adaptive' }` and the
 * closest effort they accept; `effort: 'none'` turns thinking off where the
 * model allows it and asks for the lowest effort where it does not. Older
 * models get a thinking budget, from `budgetTokens` or derived from the
 * effort, added on top of `maxTokens` so the answer keeps its room.
 */
export function claudeThinkingParams(
  model: string,
  reasoning: ReasoningConfig | undefined,
  maxTokens: number
): ClaudeThinkingParams {
  const none: ClaudeThinkingParams = { maxTokens, budgetThinking: false };
  if (!reasoning) return none;

  switch (getClaudeThinkingMode(model)) {
    case 'adaptive': {
      if (reasoning.effort === 'none') {
        switch (getClaudeThinkingOff(model)) {
          case 'disabled':
            return { ...none, thinking: { type: 'disabled' } };
          case 'between_tools':
            return { ...none, thinking: { type: 'between_tools' } };
          case 'never':
            return { ...none, effort: closestEffort(model, 'low') };
        }
      }
      return {
        ...none,
        thinking: { type: 'adaptive', display: reasoning.summary ? 'summarized' : 'omitted' },
        effort: reasoning.effort ? closestEffort(model, reasoning.effort) : undefined,
      };
    }
    case 'budget': {
      if (reasoning.effort === 'none') return none;
      const budget = Math.max(
        1024,
        reasoning.budgetTokens ?? THINKING_BUDGETS[reasoning.effort ?? 'medium']
      );
      return {
        thinking: { type: 'enabled', budget_tokens: budget },
        maxTokens: maxTokens + budget,
        budgetThinking: true,
      };
    }
    case 'none':
      return none;
  }
}

/** The effort the model accepts that is closest to `effort` without exceeding it. */
function closestEffort(model: string, effort: ReasoningEffort): ClaudeEffort | undefined {
  const levels = getClaudeEffortLevels(model);
  if (levels.length === 0) return undefined;
  const wanted: ClaudeEffort = effort === 'none' || effort === 'minimal' ? 'low' : effort;
  const ceiling = EFFORT_ORDER.indexOf(wanted);
  const accepted = levels.filter((level) => EFFORT_ORDER.indexOf(level) <= ceiling);
  return accepted.at(-1) ?? levels[0];
}

const thinkingItem = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string(),
});
const redactedThinkingItem = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});
const claudeThinkingItem = z.discriminatedUnion('type', [thinkingItem, redactedThinkingItem]);

export type ClaudeThinkingBlock =
  Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam;

/** A thinking block as an item of `ToolCall.replay.precedingItems`. */
export function toThinkingItem(
  block: Anthropic.ThinkingBlock | Anthropic.RedactedThinkingBlock
): Record<string, unknown> {
  return block.type === 'thinking'
    ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
    : { type: 'redacted_thinking', data: block.data };
}

/** The Claude thinking blocks that preceded a tool call, skipping other providers' items. */
export function thinkingBlocksOf(toolCall: ToolCall): ClaudeThinkingBlock[] {
  const blocks: ClaudeThinkingBlock[] = [];
  for (const item of toolCall.replay?.precedingItems ?? []) {
    const parsed = claudeThinkingItem.safeParse(item);
    if (parsed.success) blocks.push(parsed.data);
  }
  return blocks;
}

/** Whether an API error rejected replayed thinking blocks (signature bound elsewhere or invalid). */
export function isThinkingReplayError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 400 && /signature/i.test(error.message) && /thinking/i.test(error.message);
}
