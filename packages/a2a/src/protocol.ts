import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  A2AMessage,
  A2AMessageInput,
  A2ATask,
  Artifact,
  MessageSendParams,
  Part,
  PushNotificationConfig,
  TaskPushNotificationConfig,
  TextPart,
} from './types.js';
import { A2AError, invalidParams } from './errors.js';

const metadataSchema = z.record(z.string(), z.unknown());

const textPartSchema = z.object({
  kind: z.literal('text'),
  text: z.string(),
  metadata: metadataSchema.optional(),
});

const fileSchema = z.union([
  z.object({
    bytes: z.string(),
    mimeType: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    uri: z.string().min(1),
    mimeType: z.string().optional(),
    name: z.string().optional(),
  }),
]);

const filePartSchema = z.object({
  kind: z.literal('file'),
  file: fileSchema,
  metadata: metadataSchema.optional(),
});

const dataPartSchema = z.object({
  kind: z.literal('data'),
  data: z.record(z.string(), z.unknown()),
  metadata: metadataSchema.optional(),
});

const partSchema = z.discriminatedUnion('kind', [textPartSchema, filePartSchema, dataPartSchema]);

const messageSchema = z.object({
  kind: z.literal('message').default('message'),
  messageId: z.string().min(1),
  role: z.enum(['user', 'agent']),
  parts: z.array(partSchema),
  taskId: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
});

const nonNegativeInt = z.number().int().nonnegative();

const pushNotificationConfigSchema = z.object({
  url: z.string().min(1),
  id: z.string().min(1).optional(),
  token: z.string().optional(),
  authentication: z
    .object({ schemes: z.array(z.string()), credentials: z.string().optional() })
    .optional(),
});

const messageSendParamsSchema = z.object({
  message: messageSchema,
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
      historyLength: nonNegativeInt.optional(),
      blocking: z.boolean().optional(),
      pushNotificationConfig: pushNotificationConfigSchema.optional(),
      timeout: z.number().int().positive().optional(),
    })
    .optional(),
  metadata: metadataSchema.optional(),
  agentName: z.string().min(1).optional(),
});

const taskIdParamsSchema = z.object({
  id: z.string().min(1),
  metadata: metadataSchema.optional(),
});

const taskQueryParamsSchema = taskIdParamsSchema.extend({
  historyLength: nonNegativeInt.optional(),
});

const taskPushNotificationConfigSchema = z.object({
  taskId: z.string().min(1),
  pushNotificationConfig: pushNotificationConfigSchema,
});

const getPushNotificationConfigParamsSchema = taskIdParamsSchema.extend({
  pushNotificationConfigId: z.string().min(1).optional(),
});

const deletePushNotificationConfigParamsSchema = taskIdParamsSchema.extend({
  pushNotificationConfigId: z.string().min(1),
});

const listTasksParamsSchema = z.object({
  contextId: z.string().optional(),
  state: z
    .enum([
      'submitted',
      'working',
      'input-required',
      'completed',
      'canceled',
      'failed',
      'rejected',
      'auth-required',
      'unknown',
    ])
    .optional(),
  limit: nonNegativeInt.optional(),
  offset: nonNegativeInt.optional(),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ` : '') + issue.message)
    .join('; ');
}

function parseParams<T extends z.ZodType>(schema: T, params: unknown): z.output<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw new A2AError(invalidParams(describeIssues(parsed.error)));
  return parsed.data;
}

/** The params of `message/send` and `message/stream`, or an `InvalidParamsError`. */
export function parseMessageSendParams(params: unknown): MessageSendParams {
  return parseParams(messageSendParamsSchema, params);
}

/** The params of `tasks/get`. */
export function parseTaskQueryParams(params: unknown): z.output<typeof taskQueryParamsSchema> {
  return parseParams(taskQueryParamsSchema, params);
}

/** The params of `tasks/cancel`, `tasks/resubscribe` and `tasks/pushNotificationConfig/list`. */
export function parseTaskIdParams(params: unknown): z.output<typeof taskIdParamsSchema> {
  return parseParams(taskIdParamsSchema, params);
}

/** The params of `tasks/pushNotificationConfig/set`. */
export function parseTaskPushNotificationConfig(params: unknown): TaskPushNotificationConfig {
  return parseParams(taskPushNotificationConfigSchema, params);
}

/** The params of `tasks/pushNotificationConfig/get`. */
export function parseGetPushNotificationConfigParams(
  params: unknown
): z.output<typeof getPushNotificationConfigParamsSchema> {
  return parseParams(getPushNotificationConfigParamsSchema, params);
}

/** The params of `tasks/pushNotificationConfig/delete`. */
export function parseDeletePushNotificationConfigParams(
  params: unknown
): z.output<typeof deletePushNotificationConfigParamsSchema> {
  return parseParams(deletePushNotificationConfigParamsSchema, params);
}

/** The params of the Cogitator `tasks/list` extension method. */
export function parseListTasksParams(params: unknown): z.output<typeof listTasksParamsSchema> {
  return parseParams(listTasksParamsSchema, params);
}

/** A push notification config as the store keeps it, or an `InvalidParamsError`. */
export function parsePushNotificationConfig(config: unknown): PushNotificationConfig {
  return parseParams(pushNotificationConfigSchema, config);
}

export function newMessageId(): string {
  return `msg_${randomUUID()}`;
}

export function newArtifactId(): string {
  return `art_${randomUUID()}`;
}

export function textPart(text: string): TextPart {
  return { kind: 'text', text };
}

/** A full message from what a client composes: `kind` and a fresh `messageId` when missing. */
export function toMessage(input: A2AMessageInput): A2AMessage {
  return { ...input, kind: 'message', messageId: input.messageId ?? newMessageId() };
}

/** An agent message for a task, e.g. the reply that completes it or the error that fails it. */
export function agentMessage(task: Pick<A2ATask, 'id' | 'contextId'>, parts: Part[]): A2AMessage {
  return {
    kind: 'message',
    messageId: newMessageId(),
    role: 'agent',
    parts,
    taskId: task.id,
    contextId: task.contextId,
  };
}

/** The text of a message's text parts, joined by new lines. */
export function messageText(message: Pick<A2AMessage, 'parts'> | undefined): string {
  return (message?.parts ?? [])
    .filter((part): part is TextPart => part.kind === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** The text of an artifact's text parts. */
export function artifactText(artifact: Pick<Artifact, 'parts'>): string {
  return artifact.parts
    .filter((part): part is TextPart => part.kind === 'text')
    .map((part) => part.text)
    .join('');
}

/** Whether a `message/send` result is a task (and not a direct reply message). */
export function isA2ATask(result: { kind: string }): result is A2ATask {
  return result.kind === 'task';
}
