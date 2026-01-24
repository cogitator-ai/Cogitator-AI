import { z } from 'zod';

export const createAgentSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  model: z.string().min(1, 'Model is required'),
  instructions: z.string().min(1, 'Instructions are required').max(10000, 'Instructions too long'),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(100000).optional(),
  tools: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateAgentSchema = createAgentSchema.partial();

export const agentRunSchema = z.object({
  input: z.string().min(1, 'Input is required').max(100000, 'Input too long'),
  context: z.record(z.string(), z.unknown()).optional(),
  stream: z.boolean().optional(),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type AgentRunInput = z.infer<typeof agentRunSchema>;
