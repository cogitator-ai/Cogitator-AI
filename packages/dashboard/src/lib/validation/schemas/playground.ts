import { z } from 'zod';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

export const playgroundRequestSchema = z.object({
  model: z.string().min(1, 'Model is required'),
  messages: z.array(messageSchema).min(1, 'At least one message is required'),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(100000).optional(),
  stream: z.boolean().optional(),
  agentId: z.string().optional(),
  threadId: z.string().optional(),
});

export const chatCompletionSchema = z.object({
  model: z.string().min(1, 'Model is required'),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().nullable(),
        name: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal('function'),
              function: z.object({
                name: z.string(),
                arguments: z.string(),
              }),
            })
          )
          .optional(),
        tool_call_id: z.string().optional(),
      })
    )
    .min(1, 'At least one message is required'),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(100000).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      })
    )
    .optional(),
  tool_choice: z
    .union([
      z.literal('auto'),
      z.literal('none'),
      z.object({
        type: z.literal('function'),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
});

export type PlaygroundRequest = z.infer<typeof playgroundRequestSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionSchema>;
