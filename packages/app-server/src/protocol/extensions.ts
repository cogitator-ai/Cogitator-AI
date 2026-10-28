import { z } from 'zod';
import { protocolObject } from './common.js';

export const MemorySearchParamsSchema = protocolObject({
  query: z.string().min(1),
  threadId: z.string().optional().describe('The thread whose turns to search'),
  agent: z.string().optional().describe('The agent whose memory items to search'),
  limit: z.number().int().min(1).max(20).optional(),
});

export const MemorySearchHitSchema = z
  .union([
    z.object({
      kind: z.literal('item'),
      ref: z.string(),
      text: z.string(),
      type: z.string(),
      held: z.string().optional(),
    }),
    z.object({
      kind: z.literal('turn'),
      id: z.string(),
      date: z.string(),
      role: z.string(),
      excerpt: z.string(),
    }),
  ])
  .describe('A memory item or a turn of the thread that matches the query');

export const MemorySearchResultSchema = protocolObject({
  results: z.array(MemorySearchHitSchema),
  note: z.string().optional(),
});

export const ThreadRewindParamsSchema = protocolObject({
  threadId: z.string(),
  toEntryId: z.string().describe('The entry the active branch ends at after the rewind'),
  files: z.boolean().optional().describe('Restore the workspace files of that point too'),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional().describe('Stop the runs in the way instead of refusing'),
});

export const ThreadRewindResultSchema = protocolObject({
  threadId: z.string(),
  toEntryId: z.string(),
  dryRun: z.boolean(),
  conversation: z.object({
    rewound: z.boolean(),
    cut: z.array(z.string()),
    previousLeafId: z.string().optional(),
  }),
  runs: z.object({
    going: z.array(z.string()),
    interrupted: z.array(z.string()),
    paused: z.boolean(),
    durable: z.array(z.string()),
  }),
  files: z.record(z.string(), z.unknown()).optional(),
  report: z
    .record(z.string(), z.unknown())
    .describe('The whole report of Cogitator.rewind(), memory items included'),
});

export const RunnableSchema = z
  .object({ name: z.string(), description: z.string().optional() })
  .describe('A workflow or a swarm the host can run');

export const RunnableListParamsSchema = protocolObject({});

export const RunnableListResultSchema = protocolObject({ items: z.array(RunnableSchema) });

export const RunnableRunParamsSchema = protocolObject({
  name: z.string(),
  input: z.unknown().optional(),
});

export const RunnableRunResultSchema = protocolObject({
  runId: z.string(),
  result: z.unknown().optional(),
});

export const RunnableEventNotificationSchema = protocolObject({
  runId: z.string(),
  name: z.string(),
  event: z.unknown(),
}).describe('An event of a workflow or swarm run, sent while `run` goes on');
