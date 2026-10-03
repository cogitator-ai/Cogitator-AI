import { z } from 'zod';
import { Agent } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import type { TaskRequirements } from '@cogitator-ai/types';

const taskRequirementsSchema = z.object({
  needsVision: z.boolean().describe('The task involves images, screenshots or other visuals'),
  needsToolCalling: z
    .boolean()
    .describe('The task needs external actions: search, APIs, code execution, files'),
  needsLongContext: z
    .boolean()
    .describe('The task works over long inputs such as whole documents or codebases'),
  needsReasoning: z.enum(['basic', 'moderate', 'advanced']),
  needsSpeed: z.enum(['fast', 'balanced', 'slow-ok']),
  costSensitivity: z.enum(['low', 'medium', 'high']),
  complexity: z.enum(['simple', 'moderate', 'complex']),
  domains: z
    .array(z.string())
    .describe(
      'Subject areas, using these names where they fit: code, math, creative, analysis, legal, medical, finance'
    ),
});

const INSTRUCTIONS = `You assess tasks for a multi-agent system that picks a language model for each agent.
Read the task and describe what a model needs to handle it well. Judge the task itself; do not solve it.
Answer with JSON only.`;

/**
 * What the assessor needs from a Cogitator: running its own analysis agent and checking
 * which models it can route.
 */
export type AssessorRuntime = Pick<Cogitator, 'run' | 'route'>;

/**
 * Task analysis by a language model, for the assessor's 'ai' and 'hybrid' modes.
 */
export class AiTaskAnalyzer {
  private readonly agent: Agent;

  /**
   * @param model - model that analyzes tasks; the Cogitator's default model when omitted
   */
  constructor(
    private readonly runtime: Pick<Cogitator, 'run'>,
    model?: string
  ) {
    this.agent = new Agent({
      name: 'swarm-assessor',
      instructions: INSTRUCTIONS,
      ...(model && { model }),
      responseFormat: { type: 'json_schema', schema: taskRequirementsSchema },
    });
  }

  async analyze(task: string): Promise<TaskRequirements> {
    const result = await this.runtime.run(this.agent, {
      input: task,
      useMemory: false,
      saveHistory: false,
    });

    const parsed = taskRequirementsSchema.safeParse(result.structured);
    if (!parsed.success) {
      throw new Error('the assessor model did not return a valid task analysis');
    }
    return parsed.data;
  }
}

/**
 * Hybrid analysis: the model's judgement, plus every hard requirement the rules detected.
 * Keyword rules rarely miss an explicit need for vision, tools or long context, while the
 * model judges reasoning depth, speed, cost and complexity better.
 */
export function mergeTaskRequirements(
  ai: TaskRequirements,
  rules: TaskRequirements
): TaskRequirements {
  return {
    ...ai,
    needsVision: ai.needsVision || rules.needsVision,
    needsToolCalling: ai.needsToolCalling || rules.needsToolCalling,
    needsLongContext: ai.needsLongContext || rules.needsLongContext,
    domains: Array.from(new Set([...(ai.domains ?? []), ...(rules.domains ?? [])])),
  };
}
