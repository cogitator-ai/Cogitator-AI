import { z } from 'zod';
import {
  PendingApprovalSchema,
  PendingInterruptSchema,
  RunUsageSchema,
} from '@cogitator-ai/server-shared';
import {
  DeliverySchema,
  PermissionModeSchema,
  QueuedMessageSchema,
  UserInputSchema,
  protocolObject,
} from './common.js';
import { ReviewOutputSchema, ReviewTargetSchema } from './review.js';

export const ApprovalDecisionSchema = z
  .union([
    z.object({
      approved: z.literal(true),
      updatedArguments: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Arguments to run the call with instead'),
      remember: z.boolean().optional().describe('Also allow such calls from now on'),
    }),
    z.object({ approved: z.literal(false), reason: z.string().optional() }),
  ])
  .describe('The answer to a tool call that waits for approval');

export const TurnResumeSchema = protocolObject({
  decisions: z
    .record(z.string(), ApprovalDecisionSchema)
    .optional()
    .describe('Decisions by tool call id'),
  responses: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Answers to the interrupts by interrupt id'),
  defaultDecision: ApprovalDecisionSchema.optional().describe(
    'The decision for every call `decisions` leaves out'
  ),
}).describe('How a paused thread goes on');

export const TurnStatusSchema = z
  .enum(['inProgress', 'completed', 'paused', 'interrupted', 'failed'])
  .describe('How the turn stands: `inProgress` until it ends');

export const TurnUsageSchema = RunUsageSchema.extend({
  cost: z.number().describe('What the turn cost, in USD'),
  durationMs: z.number(),
}).describe('What the model calls of a turn used');

export const TurnErrorSchema = z
  .object({ message: z.string(), code: z.string().optional() })
  .describe('Why a turn failed');

export const TurnPendingSchema = protocolObject({
  approvals: z.array(PendingApprovalSchema),
  interrupts: z.array(PendingInterruptSchema),
}).describe('What a paused turn waits on: answer it with `turn/start` and `resume`');

export const TurnSchema = protocolObject({
  id: z.string(),
  threadId: z.string(),
  status: TurnStatusSchema,
  output: z.string().optional().describe('The answer of the agent, once the turn ended'),
  structured: z.unknown().optional().describe('The answer parsed against the output schema'),
  structuredError: z.string().optional(),
  usage: TurnUsageSchema.optional(),
  error: TurnErrorSchema.optional(),
  pending: TurnPendingSchema.optional(),
  undelivered: z.array(QueuedMessageSchema).optional(),
  review: ReviewOutputSchema.optional().describe('The findings of a review turn'),
  startedAt: z.string(),
  completedAt: z.string().optional(),
}).describe('One run of the agent in a thread');

export const TurnStartParamsSchema = protocolObject({
  threadId: z.string(),
  input: z.array(UserInputSchema).min(1).optional(),
  resume: TurnResumeSchema.optional(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('A JSON Schema the answer must match, read into `structured`'),
  model: z.string().optional().describe('A model for this turn, as `provider/model`'),
  permissionMode: PermissionModeSchema.optional(),
}).describe('Starts a turn with `input`, or resumes a paused thread with `resume`');

export const TurnStartResultSchema = protocolObject({ turn: TurnSchema });

export const TurnSteerParamsSchema = protocolObject({
  threadId: z.string(),
  expectedTurnId: z.string().describe('The turn the message is for, so it never lands in another'),
  input: z.array(UserInputSchema).min(1),
  delivery: DeliverySchema.optional().describe('`steer` by default'),
});

export const TurnSteerResultSchema = protocolObject({ turnId: z.string() });

export const TurnInterruptParamsSchema = protocolObject({
  threadId: z.string(),
  turnId: z.string(),
});

export const TurnInterruptResultSchema = protocolObject({
  undelivered: z.array(QueuedMessageSchema),
});

export const ReviewStartParamsSchema = protocolObject({
  threadId: z.string().describe('The thread the review is asked from'),
  target: ReviewTargetSchema,
  model: z.string().optional().describe('A model for the review, as `provider/model`'),
});

export const ReviewStartResultSchema = protocolObject({
  turn: TurnSchema,
  reviewThreadId: z.string().describe('The thread the review turn runs in'),
});
