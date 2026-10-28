import { z } from 'zod';
import { invalidParamsError } from '../protocol.js';
import { A2AError, invalidParams } from '../errors.js';
import { V1_ROLES, V1_TASK_STATES } from './types.js';
import type {
  V1AgentCard,
  V1OAuthFlows,
  V1Part,
  V1SecurityScheme,
  V1CancelTaskRequest,
  V1GetExtendedAgentCardRequest,
  V1GetTaskRequest,
  V1ListTaskPushNotificationConfigsRequest,
  V1ListTaskPushNotificationConfigsResponse,
  V1ListTasksRequest,
  V1ListTasksResponse,
  V1Message,
  V1SendMessageRequest,
  V1SendMessageResponse,
  V1StreamResponse,
  V1SubscribeToTaskRequest,
  V1Task,
  V1TaskPushNotificationConfig,
  V1TaskPushNotificationConfigRequest,
} from './types.js';

/**
 * Zod parsers of the A2A 1.0 wire model, as ProtoJSON reads it: field names in camelCase or in
 * the snake_case of the proto, `null` for an absent field, enums by name or number, int32 as a
 * number or a decimal string, bytes in standard or URL-safe base64. Unknown fields are dropped.
 */

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A proto message: the fields of `shape` by their JSON or proto name, `null` read as absent
 * except for the fields in `nullable` (a `google.protobuf.Value` may be JSON `null`).
 */
function message<S extends z.ZodRawShape>(shape: S, nullable: readonly string[] = []) {
  const keys = Object.keys(shape);
  return z.preprocess((input) => {
    if (!isRecord(input)) return input;
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      const alias = snakeCase(key);
      const present = key in input ? key : alias in input ? alias : undefined;
      if (present === undefined) continue;
      const value = input[present];
      if (value === undefined || (value === null && !nullable.includes(key))) continue;
      normalized[key] = value;
    }
    return normalized;
  }, z.object(shape));
}

/**
 * A proto enum by its name or number (a decimal string too, as a query parameter carries it);
 * `names` is ordered by number.
 */
function protoEnum<const T extends readonly [string, ...string[]]>(names: T) {
  const index = z
    .number()
    .int()
    .min(0)
    .max(names.length - 1);
  return z
    .union([
      z.enum(names),
      index,
      z
        .string()
        .regex(/^\d+$/)
        .transform((value) => Number(value))
        .pipe(index),
    ])
    .transform((value): T[number] => (typeof value === 'number' ? names[value] : value));
}

const int32 = z
  .union([z.number().int(), z.string().regex(/^-?\d+$/, 'must be an integer')])
  .transform((value) => Number(value))
  .pipe(z.number().int().min(-2147483648).max(2147483647));

const nonNegativeInt32 = int32.pipe(z.number().min(0, 'must not be negative'));

/** Bytes in standard or URL-safe base64, with or without padding, as standard padded base64. */
const base64Bytes = z
  .string()
  .regex(/^[A-Za-z0-9+/_-]*={0,2}$/, 'must be base64')
  .transform((value) => {
    const standard = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    return standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  });

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 timestamp');

const struct = z.record(z.string(), z.unknown());

const roleSchema = protoEnum(V1_ROLES);
const taskStateSchema = protoEnum(V1_TASK_STATES);

const partSchema = message(
  {
    text: z.string().optional(),
    raw: base64Bytes.optional(),
    url: z.string().min(1).optional(),
    data: z.unknown().optional(),
    metadata: struct.optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  },
  ['data']
)
  .superRefine((part, ctx) => {
    const contents = (['text', 'raw', 'url', 'data'] as const).filter((key) => key in part);
    if (contents.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          contents.length === 0
            ? 'a part needs one of text, raw, url or data'
            : `a part holds one of text, raw, url or data, got ${contents.join(', ')}`,
      });
    }
  })
  .transform((part): V1Part => {
    const fields = {
      ...(part.metadata && { metadata: part.metadata }),
      ...(part.filename !== undefined && { filename: part.filename }),
      ...(part.mediaType !== undefined && { mediaType: part.mediaType }),
    };
    if (part.text !== undefined) return { ...fields, text: part.text };
    if (part.raw !== undefined) return { ...fields, raw: part.raw };
    if (part.url !== undefined) return { ...fields, url: part.url };
    return { ...fields, data: part.data };
  });

const messageSchema = message({
  messageId: z.string().min(1, 'is required'),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: roleSchema.refine((role) => role !== 'ROLE_UNSPECIFIED', 'must be ROLE_USER or ROLE_AGENT'),
  parts: z.array(partSchema).min(1, 'at least one part is required'),
  metadata: struct.optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});

const artifactSchema = message({
  artifactId: z.string().min(1, 'is required'),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(partSchema),
  metadata: struct.optional(),
  extensions: z.array(z.string()).optional(),
});

const taskStatusSchema = message({
  state: taskStateSchema,
  message: messageSchema.optional(),
  timestamp: z.string().optional(),
});

const taskSchema = message({
  id: z.string().min(1, 'is required'),
  contextId: z.string().default(''),
  status: taskStatusSchema,
  artifacts: z.array(artifactSchema).optional(),
  history: z.array(messageSchema).optional(),
  metadata: struct.optional(),
});

const statusUpdateSchema = message({
  taskId: z.string(),
  contextId: z.string().default(''),
  status: taskStatusSchema,
  metadata: struct.optional(),
});

const artifactUpdateSchema = message({
  taskId: z.string(),
  contextId: z.string().default(''),
  artifact: artifactSchema,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: struct.optional(),
});

const authenticationInfoSchema = message({
  scheme: z.string().min(1, 'is required'),
  credentials: z.string().optional(),
});

const pushConfigSchema = message({
  tenant: z.string().optional(),
  id: z.string().optional(),
  taskId: z.string().optional(),
  url: z.string().min(1, 'is required'),
  token: z.string().optional(),
  authentication: authenticationInfoSchema.optional(),
});

const sendMessageConfigurationSchema = message({
  acceptedOutputModes: z.array(z.string()).optional(),
  taskPushNotificationConfig: pushConfigSchema.optional(),
  historyLength: nonNegativeInt32.optional(),
  returnImmediately: z.boolean().optional(),
});

const sendMessageRequestSchema = message({
  tenant: z.string().optional(),
  message: messageSchema,
  configuration: sendMessageConfigurationSchema.optional(),
  metadata: struct.optional(),
});

const getTaskRequestSchema = message({
  tenant: z.string().optional(),
  id: z.string().min(1, 'is required'),
  historyLength: nonNegativeInt32.optional(),
});

const listTasksRequestSchema = message({
  tenant: z.string().optional(),
  contextId: z.string().optional(),
  status: taskStateSchema.optional(),
  pageSize: int32
    .pipe(z.number().min(1, 'must be between 1 and 100').max(100, 'must be between 1 and 100'))
    .optional(),
  pageToken: z.string().optional(),
  historyLength: nonNegativeInt32.optional(),
  statusTimestampAfter: timestamp.optional(),
  includeArtifacts: z.boolean().optional(),
});

const cancelTaskRequestSchema = message({
  tenant: z.string().optional(),
  id: z.string().min(1, 'is required'),
  metadata: struct.optional(),
});

const subscribeToTaskRequestSchema = message({
  tenant: z.string().optional(),
  id: z.string().min(1, 'is required'),
});

const pushConfigRequestSchema = message({
  tenant: z.string().optional(),
  taskId: z.string().min(1, 'is required'),
  id: z.string().min(1, 'is required'),
});

const listPushConfigsRequestSchema = message({
  tenant: z.string().optional(),
  taskId: z.string().min(1, 'is required'),
  pageSize: int32.optional(),
  pageToken: z.string().optional(),
});

const getExtendedAgentCardRequestSchema = message({ tenant: z.string().optional() });

function parse<T extends z.ZodType>(schema: T, params: unknown): z.output<T> {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw invalidParamsError(parsed.error);
  return parsed.data;
}

/** The params of `SendMessage` and `SendStreamingMessage`, or an `InvalidParamsError`. */
export function parseSendMessageRequest(params: unknown): V1SendMessageRequest {
  return parse(sendMessageRequestSchema, params);
}

export function parseGetTaskRequest(params: unknown): V1GetTaskRequest {
  return parse(getTaskRequestSchema, params);
}

export function parseListTasksRequest(params: unknown): V1ListTasksRequest {
  return parse(listTasksRequestSchema, params);
}

export function parseCancelTaskRequest(params: unknown): V1CancelTaskRequest {
  return parse(cancelTaskRequestSchema, params);
}

export function parseSubscribeToTaskRequest(params: unknown): V1SubscribeToTaskRequest {
  return parse(subscribeToTaskRequestSchema, params);
}

export function parseCreatePushConfigRequest(
  params: unknown
): V1TaskPushNotificationConfig & { taskId: string } {
  const config = parse(pushConfigSchema, params);
  if (!config.taskId) {
    throw new A2AError(invalidParams('taskId: is required'), {
      fieldViolations: [{ field: 'taskId', description: 'is required' }],
    });
  }
  return { ...config, taskId: config.taskId };
}

export function parsePushConfigRequest(params: unknown): V1TaskPushNotificationConfigRequest {
  return parse(pushConfigRequestSchema, params);
}

export function parseListPushConfigsRequest(
  params: unknown
): V1ListTaskPushNotificationConfigsRequest {
  return parse(listPushConfigsRequestSchema, params);
}

export function parseGetExtendedAgentCardRequest(params: unknown): V1GetExtendedAgentCardRequest {
  return parse(getExtendedAgentCardRequestSchema, params);
}

const streamResponseSchema = message({
  task: taskSchema.optional(),
  message: messageSchema.optional(),
  statusUpdate: statusUpdateSchema.optional(),
  artifactUpdate: artifactUpdateSchema.optional(),
});

const listTasksResponseSchema = message({
  tasks: z.array(taskSchema).default([]),
  nextPageToken: z.string().default(''),
  pageSize: int32.default(0),
  totalSize: int32.default(0),
});

const listPushConfigsResponseSchema = message({
  configs: z.array(pushConfigSchema).default([]),
  nextPageToken: z.string().optional(),
});

const stringList = message({ list: z.array(z.string()).optional() });
const securityRequirementSchema = message({
  schemes: z.record(z.string(), stringList).default({}),
});
const scopes = z.record(z.string(), z.string());

const oauthFlowsFields = message({
  authorizationCode: message({
    authorizationUrl: z.string(),
    tokenUrl: z.string(),
    refreshUrl: z.string().optional(),
    scopes: scopes.default({}),
    pkceRequired: z.boolean().optional(),
  }).optional(),
  clientCredentials: message({
    tokenUrl: z.string(),
    refreshUrl: z.string().optional(),
    scopes: scopes.default({}),
  }).optional(),
  deviceCode: message({
    deviceAuthorizationUrl: z.string(),
    tokenUrl: z.string(),
    refreshUrl: z.string().optional(),
    scopes: scopes.default({}),
  }).optional(),
  implicit: message({
    authorizationUrl: z.string().optional(),
    refreshUrl: z.string().optional(),
    scopes: scopes.optional(),
  }).optional(),
  password: message({
    tokenUrl: z.string().optional(),
    refreshUrl: z.string().optional(),
    scopes: scopes.optional(),
  }).optional(),
});

/** The one flow of `OAuthFlows`, or undefined when it names none. */
const oauthFlowsSchema = oauthFlowsFields.transform((flows): V1OAuthFlows | undefined => {
  if (flows.authorizationCode) return { authorizationCode: flows.authorizationCode };
  if (flows.clientCredentials) return { clientCredentials: flows.clientCredentials };
  if (flows.deviceCode) return { deviceCode: flows.deviceCode };
  if (flows.implicit) return { implicit: flows.implicit };
  if (flows.password) return { password: flows.password };
  return undefined;
});

const securitySchemeFields = message({
  apiKeySecurityScheme: message({
    description: z.string().optional(),
    location: z.string(),
    name: z.string(),
  }).optional(),
  httpAuthSecurityScheme: message({
    description: z.string().optional(),
    scheme: z.string(),
    bearerFormat: z.string().optional(),
  }).optional(),
  oauth2SecurityScheme: message({
    description: z.string().optional(),
    flows: oauthFlowsSchema,
    oauth2MetadataUrl: z.string().optional(),
  }).optional(),
  openIdConnectSecurityScheme: message({
    description: z.string().optional(),
    openIdConnectUrl: z.string(),
  }).optional(),
  mtlsSecurityScheme: message({ description: z.string().optional() }).optional(),
});

/** The one scheme of `SecurityScheme`, or undefined when it names none this package reads. */
const securitySchemeSchema = securitySchemeFields.transform(
  (scheme): V1SecurityScheme | undefined => {
    if (scheme.apiKeySecurityScheme) return { apiKeySecurityScheme: scheme.apiKeySecurityScheme };
    if (scheme.httpAuthSecurityScheme) {
      return { httpAuthSecurityScheme: scheme.httpAuthSecurityScheme };
    }
    if (scheme.oauth2SecurityScheme?.flows) {
      const { flows, ...rest } = scheme.oauth2SecurityScheme;
      return { oauth2SecurityScheme: { ...rest, flows } };
    }
    if (scheme.openIdConnectSecurityScheme) {
      return { openIdConnectSecurityScheme: scheme.openIdConnectSecurityScheme };
    }
    if (scheme.mtlsSecurityScheme) return { mtlsSecurityScheme: scheme.mtlsSecurityScheme };
    return undefined;
  }
);

const agentCardSchema = message({
  name: z.string(),
  description: z.string().default(''),
  supportedInterfaces: z
    .array(
      message({
        url: z.string(),
        protocolBinding: z.string(),
        tenant: z.string().optional(),
        protocolVersion: z.string().default(''),
      })
    )
    .default([]),
  provider: message({ url: z.string(), organization: z.string() }).optional(),
  version: z.string().default(''),
  documentationUrl: z.string().optional(),
  capabilities: message({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extensions: z
      .array(
        message({
          uri: z.string(),
          description: z.string().optional(),
          required: z.boolean().optional(),
          params: struct.optional(),
        })
      )
      .optional(),
    extendedAgentCard: z.boolean().optional(),
  }).default({}),
  securitySchemes: z
    .record(z.string(), securitySchemeSchema)
    .transform((schemes) =>
      Object.fromEntries(
        Object.entries(schemes).filter(
          (entry): entry is [string, V1SecurityScheme] => entry[1] !== undefined
        )
      )
    )
    .optional(),
  securityRequirements: z.array(securityRequirementSchema).optional(),
  defaultInputModes: z.array(z.string()).default([]),
  defaultOutputModes: z.array(z.string()).default([]),
  skills: z
    .array(
      message({
        id: z.string(),
        name: z.string(),
        description: z.string().default(''),
        tags: z.array(z.string()).default([]),
        examples: z.array(z.string()).optional(),
        inputModes: z.array(z.string()).optional(),
        outputModes: z.array(z.string()).optional(),
        securityRequirements: z.array(securityRequirementSchema).optional(),
      })
    )
    .default([]),
  signatures: z
    .array(message({ protected: z.string(), signature: z.string(), header: struct.optional() }))
    .optional(),
  iconUrl: z.string().optional(),
});

/** Why a payload a server sent is not what A2A 1.0 says it is. */
export class V1PayloadError extends Error {
  constructor(what: string, error: z.ZodError) {
    super(
      `Invalid A2A 1.0 ${what}: ${error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`
    );
    this.name = 'V1PayloadError';
  }
}

function read<T extends z.ZodType>(schema: T, what: string, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new V1PayloadError(what, parsed.error);
  return parsed.data;
}

/** One of `task`, `message`, `statusUpdate` or `artifactUpdate`, as a stream or webhook sends it. */
export function readStreamResponse(value: unknown): V1StreamResponse {
  const parsed = read(streamResponseSchema, 'stream response', value);
  if (parsed.task) return { task: parsed.task };
  if (parsed.message) return { message: parsed.message };
  if (parsed.statusUpdate) return { statusUpdate: parsed.statusUpdate };
  if (parsed.artifactUpdate) return { artifactUpdate: parsed.artifactUpdate };
  throw new Error(
    'Invalid A2A 1.0 stream response: none of task, message, statusUpdate, artifactUpdate'
  );
}

export function readSendMessageResponse(value: unknown): V1SendMessageResponse {
  const parsed = readStreamResponse(value);
  if ('task' in parsed || 'message' in parsed) return parsed;
  throw new Error('Invalid A2A 1.0 SendMessage response: neither a task nor a message');
}

export function readTask(value: unknown): V1Task {
  return read(taskSchema, 'task', value);
}

export function readMessage(value: unknown): V1Message {
  return read(messageSchema, 'message', value);
}

export function readListTasksResponse(value: unknown): V1ListTasksResponse {
  return read(listTasksResponseSchema, 'ListTasks response', value);
}

export function readPushConfig(value: unknown): V1TaskPushNotificationConfig {
  return read(pushConfigSchema, 'push notification config', value);
}

export function readListPushConfigsResponse(
  value: unknown
): V1ListTaskPushNotificationConfigsResponse {
  return read(listPushConfigsResponseSchema, 'ListTaskPushNotificationConfigs response', value);
}

/** An A2A 1.0 Agent Card, read leniently: missing arrays become empty ones. */
export function readAgentCard(value: unknown): V1AgentCard {
  return read(agentCardSchema, 'Agent Card', value);
}
