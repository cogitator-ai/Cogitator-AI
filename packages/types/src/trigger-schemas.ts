/**
 * Schemas of routines and triggers as JSON carries them: a saved routine, one an isolated plugin
 * registers over its channel, one the CLI or a config file gives. Targets are names, secrets are
 * `{ env }` (the name of the variable that holds them, never the secret as text in a file or a
 * message), and there are no functions
 */

import { z } from 'zod';

const secret = z
  .object({ env: z.string().min(1) })
  .strict()
  .describe('The name of the environment variable that holds the secret: { "env": "NAME" }');

const base = {
  id: z.string().optional(),
  enabled: z.boolean().optional(),
  maxPerHour: z.number().int().positive().optional(),
};

const filter = z
  .object({
    field: z.string().min(1),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
  })
  .strict();

export const TriggerSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('cron'),
      cron: z.string().min(1),
      timezone: z.string().optional(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal('api'), token: secret.optional() }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('webhook'),
      secret,
      algorithm: z.enum(['sha256', 'sha512']).optional(),
      signatureHeader: z.string().optional(),
      deliveryHeader: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('github'),
      secret,
      events: z.array(z.string()).optional(),
      filters: z.array(filter).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('email'),
      provider: z.enum(['mailgun', 'postmark', 'sendgrid']),
      signingKey: secret.optional(),
      token: secret.optional(),
      basicAuth: z.object({ username: z.string(), password: secret }).strict().optional(),
      maxAgeSeconds: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('slack'),
      signingSecret: secret,
      events: z.array(z.string()).optional(),
    })
    .strict(),
]);

export const RoutineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    prompt: z.string().min(1),
    target: z.union([
      z.object({ agent: z.string().min(1) }).strict(),
      z.object({ workflow: z.string().min(1) }).strict(),
    ]),
    session: z
      .union([z.literal('new'), z.object({ threadId: z.string().min(1) }).strict()])
      .optional(),
    triggers: z.array(TriggerSpecSchema).optional(),
    overlap: z.enum(['skip', 'queue', 'parallel', 'replace']).optional(),
    maxConcurrent: z.number().int().positive().optional(),
    catchUp: z.enum(['latest', 'none', 'all']).optional(),
    catchUpWindowMs: z.number().nonnegative().optional(),
    userId: z.string().optional(),
    owner: z
      .object({
        channel: z.string().optional(),
        channelId: z.string().optional(),
        userId: z.string().optional(),
        topicId: z.string().optional(),
        conversationId: z.string().optional(),
      })
      .strict()
      .optional(),
    notify: z
      .object({ result: z.boolean().optional(), failure: z.boolean().optional() })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
