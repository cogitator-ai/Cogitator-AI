import { z } from 'zod';

const swarmStrategy = z.enum([
  'debate',
  'consensus',
  'hierarchical',
  'round-robin',
  'pipeline',
  'auction',
  'broadcast',
]);

export const createSwarmSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  description: z.string().max(1000, 'Description too long').optional(),
  strategy: swarmStrategy,
  agentIds: z.array(z.string()).min(1, 'At least one agent is required'),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const updateSwarmSchema = createSwarmSchema.partial();

export const swarmRunSchema = z.object({
  input: z.string().min(1, 'Input is required').max(100000, 'Input too long'),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type CreateSwarmInput = z.infer<typeof createSwarmSchema>;
export type UpdateSwarmInput = z.infer<typeof updateSwarmSchema>;
export type SwarmRunInput = z.infer<typeof swarmRunSchema>;
