import { z } from 'zod';
import type { DecisionAnswers, DecisionQuestions, Tool } from '@cogitator-ai/types';
import type { Cogitator } from '../runtime';
import { tool } from '../tool';

export interface DecisionToolConfig<TQuestions extends DecisionQuestions> {
  /** The tool's name, in snake_case, such as `route_ticket`. */
  name: string;
  /** What the tool decides, for the agent to know when to call it. */
  description: string;
  /** The decision model, such as `openrouter/typesafe/jev-1.13`. */
  model: string;
  /** The questions the tool asks. The agent supplies only the state. */
  questions: TQuestions;
  /** The probability from which a yes or no question answers true (default 0.5). */
  threshold?: number;
  /** What the agent should pass as the state (default "What the questions are about"). */
  stateDescription?: string;
}

export interface DecisionToolResult<TQuestions extends DecisionQuestions> {
  answers: DecisionAnswers<TQuestions>;
  /** In USD. */
  cost: number;
}

export type DecisionToolParams = { state: string | Record<string, unknown> };

/**
 * A tool an agent asks a decision model with: the questions are fixed here,
 * the agent passes the state they are about, and gets typed answers with
 * probabilities back, such as which team a support message goes to or
 * whether a message is spam.
 */
export function decisionTool<const TQuestions extends DecisionQuestions>(
  cogitator: Cogitator,
  config: DecisionToolConfig<TQuestions>
): Tool<DecisionToolParams, DecisionToolResult<TQuestions>> {
  return tool({
    name: config.name,
    description: config.description,
    parameters: z.object({
      state: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .describe(config.stateDescription ?? 'What the questions are about'),
    }),
    execute: async ({ state }, context) => {
      const result = await cogitator.decide({
        model: config.model,
        state,
        questions: config.questions,
        ...(config.threshold !== undefined && { threshold: config.threshold }),
        signal: context.signal,
      });
      return { answers: result.answers, cost: result.usage.cost };
    },
  });
}
