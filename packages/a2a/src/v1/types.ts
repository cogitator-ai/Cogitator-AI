/**
 * The A2A 1.0 wire model (`lf.a2a.v1` in ProtoJSON: camelCase fields, enums by name, no `kind`
 * discriminators). The server and the client keep their own model in the shape of A2A 0.3 and
 * translate at the boundary, so these types only describe what crosses the wire.
 */

export const V1_ROLES = ['ROLE_UNSPECIFIED', 'ROLE_USER', 'ROLE_AGENT'] as const;
export type V1Role = (typeof V1_ROLES)[number];

/** The task states in the order of their proto numbers. */
export const V1_TASK_STATES = [
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const;
export type V1TaskState = (typeof V1_TASK_STATES)[number];

export interface V1PartFields {
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

/** A part holds exactly one of `text`, `raw` (base64 bytes), `url` or `data` (any JSON value). */
export type V1Part = V1PartFields &
  ({ text: string } | { raw: string } | { url: string } | { data: unknown });

export interface V1Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: V1Role;
  parts: V1Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

export interface V1Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: V1Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

export interface V1TaskStatus {
  state: V1TaskState;
  message?: V1Message;
  timestamp?: string;
}

export interface V1Task {
  id: string;
  contextId: string;
  status: V1TaskStatus;
  artifacts?: V1Artifact[];
  history?: V1Message[];
  metadata?: Record<string, unknown>;
}

export interface V1TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: V1TaskStatus;
  metadata?: Record<string, unknown>;
}

export interface V1TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: V1Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** One event of a stream, and the payload of an A2A 1.0 webhook call. */
export type V1StreamResponse =
  | { task: V1Task }
  | { message: V1Message }
  | { statusUpdate: V1TaskStatusUpdateEvent }
  | { artifactUpdate: V1TaskArtifactUpdateEvent };

export type V1SendMessageResponse = { task: V1Task } | { message: V1Message };

export interface V1AuthenticationInfo {
  /** The HTTP authentication scheme, e.g. `Bearer` */
  scheme: string;
  credentials?: string;
}

export interface V1TaskPushNotificationConfig {
  tenant?: string;
  id?: string;
  taskId?: string;
  url: string;
  token?: string;
  authentication?: V1AuthenticationInfo;
}

export interface V1SendMessageConfiguration {
  acceptedOutputModes?: string[];
  taskPushNotificationConfig?: V1TaskPushNotificationConfig;
  historyLength?: number;
  returnImmediately?: boolean;
}

export interface V1SendMessageRequest {
  tenant?: string;
  message: V1Message;
  configuration?: V1SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export interface V1GetTaskRequest {
  tenant?: string;
  id: string;
  historyLength?: number;
}

export interface V1ListTasksRequest {
  tenant?: string;
  contextId?: string;
  status?: V1TaskState;
  pageSize?: number;
  pageToken?: string;
  historyLength?: number;
  statusTimestampAfter?: string;
  includeArtifacts?: boolean;
}

export interface V1ListTasksResponse {
  tasks: V1Task[];
  /** Empty on the last page */
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

export interface V1CancelTaskRequest {
  tenant?: string;
  id: string;
  metadata?: Record<string, unknown>;
}

export interface V1SubscribeToTaskRequest {
  tenant?: string;
  id: string;
}

export interface V1TaskPushNotificationConfigRequest {
  tenant?: string;
  taskId: string;
  id: string;
}

export interface V1ListTaskPushNotificationConfigsRequest {
  tenant?: string;
  taskId: string;
  pageSize?: number;
  pageToken?: string;
}

export interface V1ListTaskPushNotificationConfigsResponse {
  configs: V1TaskPushNotificationConfig[];
  nextPageToken?: string;
}

export interface V1GetExtendedAgentCardRequest {
  tenant?: string;
}

/** The transport bindings of A2A 1.0 this package speaks. */
export type V1ProtocolBinding = 'JSONRPC' | 'HTTP+JSON';

export interface V1AgentInterface {
  url: string;
  protocolBinding: V1ProtocolBinding | (string & {});
  /** Sent back in the `tenant` of every request to this interface */
  tenant?: string;
  /** `Major.Minor`, e.g. `1.0` */
  protocolVersion: string;
}

export interface V1AgentProvider {
  url: string;
  organization: string;
}

export interface V1AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface V1AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: V1AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface V1SecurityRequirement {
  schemes: Record<string, { list?: string[] }>;
}

export interface V1AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  securityRequirements?: V1SecurityRequirement[];
}

export interface V1AuthorizationCodeOAuthFlow {
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
  pkceRequired?: boolean;
}

export interface V1ClientCredentialsOAuthFlow {
  tokenUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

export interface V1DeviceCodeOAuthFlow {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
}

export interface V1ImplicitOAuthFlow {
  authorizationUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

export interface V1PasswordOAuthFlow {
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

/** One OAuth 2.0 flow (a `oneof` in the proto). */
export type V1OAuthFlows =
  | { authorizationCode: V1AuthorizationCodeOAuthFlow }
  | { clientCredentials: V1ClientCredentialsOAuthFlow }
  | { deviceCode: V1DeviceCodeOAuthFlow }
  | { implicit: V1ImplicitOAuthFlow }
  | { password: V1PasswordOAuthFlow };

export type V1SecurityScheme =
  | { apiKeySecurityScheme: { description?: string; location: string; name: string } }
  | { httpAuthSecurityScheme: { description?: string; scheme: string; bearerFormat?: string } }
  | {
      oauth2SecurityScheme: {
        description?: string;
        flows: V1OAuthFlows;
        oauth2MetadataUrl?: string;
      };
    }
  | { openIdConnectSecurityScheme: { description?: string; openIdConnectUrl: string } }
  | { mtlsSecurityScheme: { description?: string } };

/** A JWS signature of an Agent Card over the JCS of its A2A 1.0 form. */
export interface V1AgentCardSignature {
  protected: string;
  signature: string;
  header?: Record<string, unknown>;
}

export interface V1AgentCard {
  name: string;
  description: string;
  supportedInterfaces: V1AgentInterface[];
  provider?: V1AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: V1AgentCapabilities;
  securitySchemes?: Record<string, V1SecurityScheme>;
  securityRequirements?: V1SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: V1AgentSkill[];
  signatures?: V1AgentCardSignature[];
  iconUrl?: string;
}

/** `google.rpc.ErrorInfo` as an entry of an error's details. */
export interface V1ErrorInfo {
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo';
  /** The A2A error in UPPER_SNAKE_CASE without `Error`, e.g. `TASK_NOT_FOUND` */
  reason: string;
  domain: string;
  metadata?: Record<string, string>;
}

/** `google.rpc.BadRequest` as an entry of an error's details. */
export interface V1BadRequest {
  '@type': 'type.googleapis.com/google.rpc.BadRequest';
  fieldViolations: { field: string; description: string }[];
}

export type V1ErrorDetail =
  V1ErrorInfo | V1BadRequest | ({ '@type': string } & Record<string, unknown>);

/** The body of an HTTP+JSON error response (`google.rpc.Status`). */
export interface V1RestErrorBody {
  error: {
    code: number;
    status: string;
    message: string;
    details: V1ErrorDetail[];
  };
}
