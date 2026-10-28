import type {
  A2AMessage,
  A2AStreamEvent,
  A2ATask,
  Artifact,
  MessageSendParams,
  OAuthFlow,
  Part,
  PushNotificationConfig,
  SecurityScheme,
  TaskArtifactUpdateEvent,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '../types.js';
import { isStreamFinalState } from '../types.js';
import { runTimeoutFromMetadata, RUN_TIMEOUT_EXTENSION } from '../extensions.js';
import type {
  V1Artifact,
  V1Message,
  V1OAuthFlows,
  V1Part,
  V1SecurityRequirement,
  V1SecurityScheme,
  V1SendMessageRequest,
  V1StreamResponse,
  V1Task,
  V1TaskArtifactUpdateEvent,
  V1TaskPushNotificationConfig,
  V1TaskState,
  V1TaskStatus,
  V1TaskStatusUpdateEvent,
} from './types.js';

/**
 * Part metadata key marking a data part that wraps an A2A 1.0 `data` value that is not an object
 * (a string, number, boolean, array or null) as `{ value }`, the only form an A2A 0.3 data part
 * holds. The 1.0 form gets the bare value back.
 */
export const DATA_VALUE_KEY = 'cogitator:dataValue';

const STATE_TO_V1: Record<TaskState, V1TaskState> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  canceled: 'TASK_STATE_CANCELED',
  failed: 'TASK_STATE_FAILED',
  rejected: 'TASK_STATE_REJECTED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
  unknown: 'TASK_STATE_UNSPECIFIED',
};

const STATE_FROM_V1: Record<V1TaskState, TaskState> = {
  TASK_STATE_UNSPECIFIED: 'unknown',
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_AUTH_REQUIRED: 'auth-required',
};

export function taskStateToV1(state: TaskState): V1TaskState {
  return STATE_TO_V1[state];
}

export function taskStateFromV1(state: V1TaskState): TaskState {
  return STATE_FROM_V1[state];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty<T>(items: readonly T[] | undefined): T[] | undefined {
  return items && items.length > 0 ? [...items] : undefined;
}

function withoutKey(
  metadata: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  if (!metadata || !(key in metadata)) return metadata;
  const rest = Object.fromEntries(Object.entries(metadata).filter(([name]) => name !== key));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function partToV1(part: Part): V1Part {
  switch (part.kind) {
    case 'text':
      return { text: part.text, ...(part.metadata && { metadata: part.metadata }) };
    case 'file': {
      const { file } = part;
      const fields = {
        ...(part.metadata && { metadata: part.metadata }),
        ...(file.name !== undefined && { filename: file.name }),
        ...(file.mimeType !== undefined && { mediaType: file.mimeType }),
      };
      return 'uri' in file ? { ...fields, url: file.uri } : { ...fields, raw: file.bytes };
    }
    case 'data': {
      const wrapped = part.metadata?.[DATA_VALUE_KEY] === true && 'value' in part.data;
      const metadata = wrapped ? withoutKey(part.metadata, DATA_VALUE_KEY) : part.metadata;
      return {
        data: wrapped ? part.data.value : part.data,
        ...(metadata && { metadata }),
      };
    }
  }
}

export function partFromV1(part: V1Part): Part {
  if ('text' in part) {
    return { kind: 'text', text: part.text, ...(part.metadata && { metadata: part.metadata }) };
  }
  if ('raw' in part || 'url' in part) {
    const described = {
      ...(part.mediaType && { mimeType: part.mediaType }),
      ...(part.filename && { name: part.filename }),
    };
    return {
      kind: 'file',
      file: 'url' in part ? { uri: part.url, ...described } : { bytes: part.raw, ...described },
      ...(part.metadata && { metadata: part.metadata }),
    };
  }
  if (isPlainObject(part.data)) {
    return { kind: 'data', data: part.data, ...(part.metadata && { metadata: part.metadata }) };
  }
  return {
    kind: 'data',
    data: { value: part.data },
    metadata: { ...part.metadata, [DATA_VALUE_KEY]: true },
  };
}

export function messageToV1(message: A2AMessage): V1Message {
  return {
    messageId: message.messageId,
    ...(message.contextId && { contextId: message.contextId }),
    ...(message.taskId && { taskId: message.taskId }),
    role: message.role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER',
    parts: message.parts.map(partToV1),
    ...(message.metadata && { metadata: message.metadata }),
    ...(nonEmpty(message.extensions) && { extensions: [...(message.extensions ?? [])] }),
    ...(nonEmpty(message.referenceTaskIds) && {
      referenceTaskIds: [...(message.referenceTaskIds ?? [])],
    }),
  };
}

export function messageFromV1(message: V1Message): A2AMessage {
  return {
    kind: 'message',
    messageId: message.messageId,
    role: message.role === 'ROLE_AGENT' ? 'agent' : 'user',
    parts: message.parts.map(partFromV1),
    ...(message.contextId && { contextId: message.contextId }),
    ...(message.taskId && { taskId: message.taskId }),
    ...(nonEmpty(message.referenceTaskIds) && {
      referenceTaskIds: [...(message.referenceTaskIds ?? [])],
    }),
    ...(nonEmpty(message.extensions) && { extensions: [...(message.extensions ?? [])] }),
    ...(message.metadata && { metadata: message.metadata }),
  };
}

export function artifactToV1(artifact: Artifact): V1Artifact {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name && { name: artifact.name }),
    ...(artifact.description && { description: artifact.description }),
    parts: artifact.parts.map(partToV1),
    ...(artifact.metadata && { metadata: artifact.metadata }),
    ...(nonEmpty(artifact.extensions) && { extensions: [...(artifact.extensions ?? [])] }),
  };
}

export function artifactFromV1(artifact: V1Artifact): Artifact {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name && { name: artifact.name }),
    ...(artifact.description && { description: artifact.description }),
    parts: artifact.parts.map(partFromV1),
    ...(nonEmpty(artifact.extensions) && { extensions: [...(artifact.extensions ?? [])] }),
    ...(artifact.metadata && { metadata: artifact.metadata }),
  };
}

export function taskStatusToV1(status: TaskStatus): V1TaskStatus {
  return {
    state: taskStateToV1(status.state),
    ...(status.message && { message: messageToV1(status.message) }),
    ...(status.timestamp && { timestamp: status.timestamp }),
  };
}

export function taskStatusFromV1(status: V1TaskStatus): TaskStatus {
  return {
    state: taskStateFromV1(status.state),
    ...(status.message && { message: messageFromV1(status.message) }),
    ...(status.timestamp && { timestamp: status.timestamp }),
  };
}

/**
 * A task in its A2A 1.0 form. Empty `history` and `artifacts` are left out, as ProtoJSON leaves
 * out empty repeated fields, so a `historyLength` of 0 omits the history.
 */
export function taskToV1(task: A2ATask): V1Task {
  return {
    id: task.id,
    contextId: task.contextId,
    status: taskStatusToV1(task.status),
    ...(nonEmpty(task.artifacts) && { artifacts: (task.artifacts ?? []).map(artifactToV1) }),
    ...(nonEmpty(task.history) && { history: (task.history ?? []).map(messageToV1) }),
    ...(task.metadata && { metadata: task.metadata }),
  };
}

export function taskFromV1(task: V1Task): A2ATask {
  return {
    kind: 'task',
    id: task.id,
    contextId: task.contextId,
    status: taskStatusFromV1(task.status),
    ...(task.history && { history: task.history.map(messageFromV1) }),
    ...(task.artifacts && { artifacts: task.artifacts.map(artifactFromV1) }),
    ...(task.metadata && { metadata: task.metadata }),
  };
}

export function statusUpdateToV1(event: TaskStatusUpdateEvent): V1TaskStatusUpdateEvent {
  return {
    taskId: event.taskId,
    contextId: event.contextId,
    status: taskStatusToV1(event.status),
    ...(event.metadata && { metadata: event.metadata }),
  };
}

/**
 * A status update in the internal form. A2A 1.0 has no `final`: the stream ends on a terminal or
 * interrupted state, which is what `final` marks.
 */
export function statusUpdateFromV1(event: V1TaskStatusUpdateEvent): TaskStatusUpdateEvent {
  const status = taskStatusFromV1(event.status);
  return {
    kind: 'status-update',
    taskId: event.taskId,
    contextId: event.contextId,
    status,
    final: isStreamFinalState(status.state),
    ...(event.metadata && { metadata: event.metadata }),
  };
}

export function artifactUpdateToV1(event: TaskArtifactUpdateEvent): V1TaskArtifactUpdateEvent {
  return {
    taskId: event.taskId,
    contextId: event.contextId,
    artifact: artifactToV1(event.artifact),
    ...(event.append && { append: true }),
    ...(event.lastChunk && { lastChunk: true }),
    ...(event.metadata && { metadata: event.metadata }),
  };
}

/** An artifact update in the internal form; an absent `lastChunk` is `false`, as in ProtoJSON. */
export function artifactUpdateFromV1(event: V1TaskArtifactUpdateEvent): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId: event.taskId,
    contextId: event.contextId,
    artifact: artifactFromV1(event.artifact),
    ...(event.append && { append: true }),
    lastChunk: event.lastChunk ?? false,
    ...(event.metadata && { metadata: event.metadata }),
  };
}

export function streamEventToV1(event: A2AStreamEvent): V1StreamResponse {
  switch (event.kind) {
    case 'task':
      return { task: taskToV1(event) };
    case 'message':
      return { message: messageToV1(event) };
    case 'status-update':
      return { statusUpdate: statusUpdateToV1(event) };
    case 'artifact-update':
      return { artifactUpdate: artifactUpdateToV1(event) };
  }
}

export function streamEventFromV1(response: V1StreamResponse): A2AStreamEvent {
  if ('task' in response) return taskFromV1(response.task);
  if ('message' in response) return messageFromV1(response.message);
  if ('statusUpdate' in response) return statusUpdateFromV1(response.statusUpdate);
  return artifactUpdateFromV1(response.artifactUpdate);
}

/** A push notification config in its A2A 1.0 form, without the server's own fields. */
export function pushConfigToV1(
  config: PushNotificationConfig,
  taskId?: string
): V1TaskPushNotificationConfig {
  const scheme = config.authentication?.schemes[0];
  return {
    ...(config.id && { id: config.id }),
    ...(taskId && { taskId }),
    url: config.url,
    ...(config.token && { token: config.token }),
    ...(scheme && {
      authentication: {
        scheme,
        ...(config.authentication?.credentials && {
          credentials: config.authentication.credentials,
        }),
      },
    }),
  };
}

export function pushConfigFromV1(config: V1TaskPushNotificationConfig): PushNotificationConfig {
  return {
    url: config.url,
    ...(config.id && { id: config.id }),
    ...(config.token && { token: config.token }),
    ...(config.authentication && {
      authentication: {
        schemes: [config.authentication.scheme],
        ...(config.authentication.credentials && {
          credentials: config.authentication.credentials,
        }),
      },
    }),
  };
}

/**
 * The params of an A2A 1.0 `SendMessage` in the internal form: `returnImmediately` is
 * `blocking: false`, the push config of the configuration is registered over 1.0, and the run
 * timeout comes from the run-timeout extension's metadata entry.
 */
export function sendMessageRequestFromV1(request: V1SendMessageRequest): MessageSendParams {
  const configuration = request.configuration;
  const timeout =
    runTimeoutFromMetadata(request.metadata) ?? runTimeoutFromMetadata(request.message.metadata);
  const push = configuration?.taskPushNotificationConfig;
  const internal = {
    ...(configuration?.acceptedOutputModes?.length && {
      acceptedOutputModes: configuration.acceptedOutputModes,
    }),
    ...(configuration?.historyLength !== undefined && {
      historyLength: configuration.historyLength,
    }),
    ...(configuration?.returnImmediately && { blocking: false }),
    ...(push && {
      pushNotificationConfig: { ...pushConfigFromV1(push), protocolVersion: '1.0' as const },
    }),
    ...(timeout !== undefined && { timeout }),
  };
  return {
    message: messageFromV1(request.message),
    ...(Object.keys(internal).length > 0 && { configuration: internal }),
    ...(request.metadata && { metadata: request.metadata }),
  };
}

/** A message send in its A2A 1.0 form, as the client sends it. */
export function sendMessageRequestToV1(
  params: MessageSendParams,
  tenant?: string
): V1SendMessageRequest {
  const configuration = params.configuration;
  const push = configuration?.pushNotificationConfig;
  const v1Configuration = {
    ...(configuration?.acceptedOutputModes?.length && {
      acceptedOutputModes: configuration.acceptedOutputModes,
    }),
    ...(push && { taskPushNotificationConfig: pushConfigToV1(push) }),
    ...(configuration?.historyLength !== undefined && {
      historyLength: configuration.historyLength,
    }),
    ...(configuration?.blocking === false && { returnImmediately: true }),
  };
  const metadata =
    configuration?.timeout !== undefined
      ? { ...params.metadata, [RUN_TIMEOUT_EXTENSION]: { timeoutMs: configuration.timeout } }
      : params.metadata;
  return {
    ...(tenant && { tenant }),
    message: messageToV1(params.message),
    ...(Object.keys(v1Configuration).length > 0 && { configuration: v1Configuration }),
    ...(metadata && { metadata }),
  };
}

const FLOW_ORDER = [
  'authorizationCode',
  'clientCredentials',
  'deviceCode',
  'implicit',
  'password',
] as const;

/** The flows of an A2A 0.3 scheme as the one flow A2A 1.0 holds: the first by this order. */
function oauthFlowsToV1(
  flows: Partial<Record<(typeof FLOW_ORDER)[number], OAuthFlow>>
): V1OAuthFlows | undefined {
  for (const name of FLOW_ORDER) {
    const flow = flows[name];
    if (!flow) continue;
    const refresh = flow.refreshUrl ? { refreshUrl: flow.refreshUrl } : {};
    switch (name) {
      case 'authorizationCode':
        return {
          authorizationCode: {
            authorizationUrl: flow.authorizationUrl ?? '',
            tokenUrl: flow.tokenUrl ?? '',
            ...refresh,
            scopes: { ...flow.scopes },
            ...(flow.pkceRequired && { pkceRequired: true }),
          },
        };
      case 'clientCredentials':
        return {
          clientCredentials: {
            tokenUrl: flow.tokenUrl ?? '',
            ...refresh,
            scopes: { ...flow.scopes },
          },
        };
      case 'deviceCode':
        return {
          deviceCode: {
            deviceAuthorizationUrl: flow.deviceAuthorizationUrl ?? '',
            tokenUrl: flow.tokenUrl ?? '',
            ...refresh,
            scopes: { ...flow.scopes },
          },
        };
      case 'implicit':
        return {
          implicit: {
            ...(flow.authorizationUrl && { authorizationUrl: flow.authorizationUrl }),
            ...refresh,
            scopes: { ...flow.scopes },
          },
        };
      case 'password':
        return {
          password: {
            ...(flow.tokenUrl && { tokenUrl: flow.tokenUrl }),
            ...refresh,
            scopes: { ...flow.scopes },
          },
        };
    }
  }
  return undefined;
}

function oauthFlowsFromV1(
  flows: V1OAuthFlows
): Partial<Record<(typeof FLOW_ORDER)[number], OAuthFlow>> {
  if ('authorizationCode' in flows) {
    const flow = flows.authorizationCode;
    return {
      authorizationCode: {
        authorizationUrl: flow.authorizationUrl,
        tokenUrl: flow.tokenUrl,
        ...(flow.refreshUrl && { refreshUrl: flow.refreshUrl }),
        scopes: { ...flow.scopes },
        ...(flow.pkceRequired && { pkceRequired: true }),
      },
    };
  }
  if ('clientCredentials' in flows) {
    const flow = flows.clientCredentials;
    return {
      clientCredentials: {
        tokenUrl: flow.tokenUrl,
        ...(flow.refreshUrl && { refreshUrl: flow.refreshUrl }),
        scopes: { ...flow.scopes },
      },
    };
  }
  if ('deviceCode' in flows) {
    const flow = flows.deviceCode;
    return {
      deviceCode: {
        deviceAuthorizationUrl: flow.deviceAuthorizationUrl,
        tokenUrl: flow.tokenUrl,
        ...(flow.refreshUrl && { refreshUrl: flow.refreshUrl }),
        scopes: { ...flow.scopes },
      },
    };
  }
  if ('implicit' in flows) {
    const flow = flows.implicit;
    return {
      implicit: {
        ...(flow.authorizationUrl && { authorizationUrl: flow.authorizationUrl }),
        ...(flow.refreshUrl && { refreshUrl: flow.refreshUrl }),
        scopes: { ...flow.scopes },
      },
    };
  }
  const flow = flows.password;
  return {
    password: {
      ...(flow.tokenUrl && { tokenUrl: flow.tokenUrl }),
      ...(flow.refreshUrl && { refreshUrl: flow.refreshUrl }),
      scopes: { ...flow.scopes },
    },
  };
}

function described(description: string | undefined): { description?: string } {
  return description ? { description } : {};
}

/** An A2A 0.3 security scheme in its A2A 1.0 form, or undefined for an OAuth scheme without flows. */
export function securitySchemeToV1(scheme: SecurityScheme): V1SecurityScheme | undefined {
  switch (scheme.type) {
    case 'apiKey':
      return {
        apiKeySecurityScheme: {
          ...described(scheme.description),
          location: scheme.in,
          name: scheme.name,
        },
      };
    case 'http':
      return {
        httpAuthSecurityScheme: {
          ...described(scheme.description),
          scheme: scheme.scheme,
          ...(scheme.bearerFormat && { bearerFormat: scheme.bearerFormat }),
        },
      };
    case 'oauth2': {
      const flows = oauthFlowsToV1(scheme.flows);
      if (!flows) return undefined;
      return {
        oauth2SecurityScheme: {
          ...described(scheme.description),
          flows,
          ...(scheme.oauth2MetadataUrl && { oauth2MetadataUrl: scheme.oauth2MetadataUrl }),
        },
      };
    }
    case 'openIdConnect':
      return {
        openIdConnectSecurityScheme: {
          ...described(scheme.description),
          openIdConnectUrl: scheme.openIdConnectUrl,
        },
      };
    case 'mutualTLS':
      return { mtlsSecurityScheme: described(scheme.description) };
  }
}

const API_KEY_LOCATIONS = ['header', 'query', 'cookie'] as const;

export function securitySchemeFromV1(scheme: V1SecurityScheme): SecurityScheme {
  if ('apiKeySecurityScheme' in scheme) {
    const { location, name, description } = scheme.apiKeySecurityScheme;
    const where = API_KEY_LOCATIONS.find((candidate) => candidate === location.toLowerCase());
    return { type: 'apiKey', in: where ?? 'header', name, ...described(description) };
  }
  if ('httpAuthSecurityScheme' in scheme) {
    const { scheme: name, bearerFormat, description } = scheme.httpAuthSecurityScheme;
    return {
      type: 'http',
      scheme: name,
      ...(bearerFormat && { bearerFormat }),
      ...described(description),
    };
  }
  if ('oauth2SecurityScheme' in scheme) {
    const { flows, oauth2MetadataUrl, description } = scheme.oauth2SecurityScheme;
    return {
      type: 'oauth2',
      flows: oauthFlowsFromV1(flows),
      ...(oauth2MetadataUrl && { oauth2MetadataUrl }),
      ...described(description),
    };
  }
  if ('openIdConnectSecurityScheme' in scheme) {
    const { openIdConnectUrl, description } = scheme.openIdConnectSecurityScheme;
    return { type: 'openIdConnect', openIdConnectUrl, ...described(description) };
  }
  return { type: 'mutualTLS', ...described(scheme.mtlsSecurityScheme.description) };
}

export function securityRequirementsToV1(
  security: readonly Record<string, string[]>[]
): V1SecurityRequirement[] {
  return security.map((requirement) => ({
    schemes: Object.fromEntries(
      Object.entries(requirement).map(([name, scopes]) => [
        name,
        scopes.length > 0 ? { list: [...scopes] } : {},
      ])
    ),
  }));
}

export function securityRequirementsFromV1(
  requirements: readonly V1SecurityRequirement[]
): Record<string, string[]>[] {
  return requirements.map((requirement) =>
    Object.fromEntries(
      Object.entries(requirement.schemes).map(([name, scopes]) => [name, [...(scopes.list ?? [])]])
    )
  );
}
