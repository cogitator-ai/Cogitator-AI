import { z } from 'zod';

/** A git revision a client names: never one that starts with `-`, which git reads as an option */
const RevisionSchema = z.string().min(1).regex(/^[^-]/, 'A revision must not start with "-"');

export const ReviewTargetSchema = z
  .discriminatedUnion('type', [
    z
      .object({ type: z.literal('uncommittedChanges') })
      .describe('The staged, unstaged and untracked changes of the working tree'),
    z
      .object({ type: z.literal('baseBranch'), branch: RevisionSchema })
      .describe('The changes of the current branch against `branch`'),
    z
      .object({
        type: z.literal('commit'),
        sha: RevisionSchema,
        title: z.string().optional(),
      })
      .describe('The changes of one commit'),
    z
      .object({ type: z.literal('custom'), instructions: z.string().min(1) })
      .describe('What to review, in your own words'),
  ])
  .describe('What a review looks at');

export const ReviewLocationSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});

export const ReviewFindingSchema = z
  .object({
    title: z.string().describe('One line naming the problem'),
    body: z.string().describe('Why it is a problem and what to do about it'),
    priority: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe('0 for a problem that must be fixed before merging, up to 3 for a nit'),
    confidence: z.number().min(0).max(1).describe('How sure the reviewer is, from 0 to 1'),
    location: ReviewLocationSchema.optional(),
  })
  .describe('One problem a review found');

export const ReviewOutputSchema = z
  .object({
    findings: z.array(ReviewFindingSchema),
    overallCorrectness: z
      .enum(['correct', 'incorrect'])
      .describe('Whether the changes do what they mean to without breaking anything'),
    overallExplanation: z.string(),
  })
  .describe('What a review found');
