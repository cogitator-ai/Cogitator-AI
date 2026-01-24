import { z } from 'zod';

const workflowNodeSchema = z.object({
  id: z.string(),
  type: z.enum(['agent', 'condition', 'parallel', 'loop', 'transform', 'input', 'output']),
  position: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
});

export const createWorkflowSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  description: z.string().max(1000, 'Description too long').optional(),
  nodes: z.array(workflowNodeSchema).optional(),
  edges: z.array(workflowEdgeSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateWorkflowSchema = createWorkflowSchema.partial();

export const workflowRunSchema = z.object({
  input: z.union([z.string(), z.record(z.string(), z.unknown())]),
  context: z.record(z.string(), z.unknown()).optional(),
  checkpointId: z.string().optional(),
});

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type WorkflowRunInput = z.infer<typeof workflowRunSchema>;
