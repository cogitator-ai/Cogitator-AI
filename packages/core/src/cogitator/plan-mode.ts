import { z } from 'zod';
import type { Tool } from '@cogitator-ai/types';
import { tool } from '../tool';
import { EXIT_PLAN_MODE, type RunPermissions } from './run-permissions';

const PlanAnswerSchema = z.object({
  approved: z.boolean().describe('Whether the plan may be carried out'),
  mode: z
    .enum(['default', 'acceptEdits', 'dontAsk'])
    .optional()
    .describe(
      "The permission mode to carry the plan out in (default: default). The modes that ask less (auto, bypassPermissions) are the host's to set, not an answer's"
    ),
  feedback: z.string().optional().describe('What to change in the plan, when it is not approved'),
});

/**
 * The tool a run in `plan` mode presents its plan with: the run pauses with an interrupt of kind
 * `plan` holding the plan, and once a person approves it the run leaves `plan` mode for the mode
 * the answer names (`default` unless it names one) and the model carries the plan out. A plan
 * not approved keeps the run in `plan` mode, the model reads the feedback
 */
export function exitPlanModeTool(permissions: RunPermissions): Tool {
  return tool({
    name: EXIT_PLAN_MODE,
    description:
      'Present your plan for approval once you have read enough to know what to do. Only read-only tools run until the user approves the plan: then you can edit files and run commands to carry it out. Write the plan as concise Markdown steps.',
    parameters: z.object({
      plan: z.string().min(1).describe('The plan, as Markdown'),
    }),
    presentation: { label: 'Present plan', icon: 'list-checks' },
    execute: async ({ plan }, context) => {
      if (permissions.mode !== 'plan') {
        return 'The run is not in plan mode: carry on with the task.';
      }
      if (!context.interrupt) {
        throw new Error(
          `${EXIT_PLAN_MODE} needs a run that can pause for the approval of the plan`
        );
      }
      const answer = await context.interrupt({
        kind: 'plan',
        reason: 'plan_approval',
        message: 'Approve the plan so the agent can carry it out',
        details: { plan },
        responseSchema: PlanAnswerSchema,
      });
      if (!answer.approved) {
        return `The user did not approve the plan${answer.feedback ? `: ${answer.feedback}` : ''}. Stay in plan mode, revise the plan and present it again with ${EXIT_PLAN_MODE}.`;
      }
      const mode = answer.mode ?? 'default';
      try {
        permissions.setMode(mode);
      } catch (error) {
        permissions.setMode('default');
        return `The user approved the plan. ${error instanceof Error ? error.message : String(error)}, so the run is in default mode now. Carry the plan out.`;
      }
      return `The user approved the plan, the run is in ${mode} mode now. Carry the plan out.`;
    },
  });
}
