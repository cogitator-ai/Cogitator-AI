import type { JsonWebKey, KeyObject } from 'node:crypto';
import type {
  Agent,
  RunCheckpoint,
  RunInterrupt,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import type { A2AProtocolVersion } from './version.js';
import type { V1AgentInterface } from './v1/types.js';

/** The A2A 0.3 protocol version, as the `protocolVersion` of an A2A 0.3 Agent Card declares it. */
export const A2A_PROTOCOL_VERSION = '0.3.0';

/** The A2A 1.0 protocol version, as the interfaces of an Agent Card declare it. */
export const A2A_V1_PROTOCOL_VERSION = '1.0';

/** Where a Cogitator server publishes the public keys its Agent Cards are signed with. */
export const JWKS_PATH = '/.well-known/jwks.json';

/** Where an A2A server publishes its Agent Card (A2A v0.3, section 5.3). */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** Where A2A servers before protocol v0.3 published their Agent Card. */
export const LEGACY_AGENT_CARD_PATH = '/.well-known/agent.json';

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

export const TERMINAL_STATES = ['completed', 'failed', 'canceled', 'rejected'] as const;

export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * States after which an interaction waits on the client: terminal states plus `input-required`
 * and `auth-required`. The status update that reaches one of them is the `final` event of a
 * stream.
 */
export function isStreamFinalState(state: TaskState): boolean {
  return state === 'input-required' || state === 'auth-required' || isTerminalState(state);
}

export interface TextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FileWithUri {
  uri: string;
  mimeType?: string;
  name?: string;
}

export interface FileWithBytes {
  /** The file content, base64-encoded */
  bytes: string;
  mimeType?: string;
  name?: string;
}

export interface FilePart {
  kind: 'file';
  file: FileWithUri | FileWithBytes;
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface A2AMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: Part[];
  taskId?: string;
  contextId?: string;
  referenceTaskIds?: string[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * A message as the client composes it: `kind` and `messageId` are filled in when left out.
 */
export type A2AMessageInput = Omit<A2AMessage, 'kind' | 'messageId'> &
  Partial<Pick<A2AMessage, 'kind' | 'messageId'>>;

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  extensions?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  /** An agent message about the state, e.g. the question of `input-required` or the error of `failed` */
  message?: A2AMessage;
  /** ISO 8601 time of the change */
  timestamp?: string;
}

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId: string;
  status: TaskStatus;
  history?: A2AMessage[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface AgentProvider {
  organization: string;
  url: string;
}

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface A2ACapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: AgentExtension[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  security?: Record<string, string[]>[];
}

export interface OAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: Record<string, string>;
  /** A2A 1.0: the device authorization endpoint of the `deviceCode` flow */
  deviceAuthorizationUrl?: string;
  /** A2A 1.0: the `authorizationCode` flow requires PKCE */
  pkceRequired?: boolean;
}

export type SecurityScheme =
  | { type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string; description?: string }
  | { type: 'http'; scheme: string; bearerFormat?: string; description?: string }
  | {
      type: 'oauth2';
      /** `deviceCode` exists only in A2A 1.0 */
      flows: Partial<
        Record<
          'authorizationCode' | 'clientCredentials' | 'deviceCode' | 'implicit' | 'password',
          OAuthFlow
        >
      >;
      oauth2MetadataUrl?: string;
      description?: string;
    }
  | { type: 'openIdConnect'; openIdConnectUrl: string; description?: string }
  | { type: 'mutualTLS'; description?: string };

export type TransportProtocol = 'JSONRPC' | 'GRPC' | 'HTTP+JSON';

export interface AgentInterface {
  transport: TransportProtocol | (string & {});
  url: string;
}

/** A JWS signature of an Agent Card (RFC 7515, detached payload). */
export interface AgentCardSignature {
  /** The protected JWS header, base64url-encoded JSON */
  protected: string;
  /** The signature, base64url-encoded */
  signature: string;
  header?: Record<string, unknown>;
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  /** The endpoint of `preferredTransport` */
  url: string;
  preferredTransport?: TransportProtocol | (string & {});
  additionalInterfaces?: AgentInterface[];
  version: string;
  provider?: AgentProvider;
  iconUrl?: string;
  documentationUrl?: string;
  capabilities: A2ACapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Record<string, string[]>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  supportsAuthenticatedExtendedCard?: boolean;
  signatures?: AgentCardSignature[];
  /**
   * Every interface of the agent with its protocol version, as A2A 1.0 lists them. A Cogitator
   * server adds them to the A2A 0.3 card, so a client of either version finds its endpoint.
   */
  supportedInterfaces?: V1AgentInterface[];
}

/** The card `agent/getAuthenticatedExtendedCard` returns: an Agent Card with more detail. */
export type ExtendedAgentCard = AgentCard;

export interface PushNotificationAuthenticationInfo {
  /** Schemes the webhook accepts, e.g. `Bearer` or `Basic` */
  schemes: string[];
  /** Credentials for the first supported scheme: a bearer token or base64 `user:password` */
  credentials?: string;
}

export interface PushNotificationConfig {
  /** The webhook the server POSTs the task to on every status change */
  url: string;
  id?: string;
  /** Sent back in the `X-A2A-Notification-Token` header so the webhook can check the sender */
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
  /**
   * Set by the server: the protocol version the config was registered with, which decides the
   * payload of the webhook calls (`{ task }` as `application/a2a+json` for 1.0). Never sent to
   * clients, and absent on configs registered over A2A 0.3.
   */
  protocolVersion?: A2AProtocolVersion;
}

export interface TaskPushNotificationConfig {
  taskId: string;
  pushNotificationConfig: PushNotificationConfig;
}

export interface MessageSendConfiguration {
  /** Only return artifacts with a part of one of these MIME types */
  acceptedOutputModes?: string[];
  /** Trim the returned task history to the last N messages (0 = no history) */
  historyLength?: number;
  /** Wait for the task to finish (default: true). When false the task is returned while still running. */
  blocking?: boolean;
  /** Register a push notification webhook before the task starts executing */
  pushNotificationConfig?: PushNotificationConfig;
  /**
   * Cogitator extension: a shorter run time limit for this task, in ms. The server never lets it
   * exceed the agent's own timeout or `maxRunTimeoutMs`.
   */
  timeout?: number;
}

/** @deprecated Renamed to `MessageSendConfiguration`, its name in the A2A specification */
export type SendMessageConfiguration = MessageSendConfiguration;

export interface MessageSendParams {
  message: A2AMessage;
  configuration?: MessageSendConfiguration;
  metadata?: Record<string, unknown>;
  /**
   * Cogitator extension: the agent to address on a server hosting several, when the request goes
   * to the shared endpoint. Each agent also has its own endpoint, named in its Agent Card.
   */
  agentName?: string;
}

export interface TaskFilter {
  contextId?: string;
  state?: TaskState;
  /**
   * Only tasks this caller may see: those it owns and those without an
   * owner. `null` stands for a caller without a user (no auth, or `validate`
   * returned `true`), who sees only tasks without an owner.
   */
  visibleTo?: string | null;
  limit?: number;
  offset?: number;
}

export interface TaskStore {
  create(task: A2ATask): Promise<void>;
  get(taskId: string): Promise<A2ATask | null>;
  update(taskId: string, update: Partial<A2ATask>): Promise<void>;
  list(filter?: TaskFilter): Promise<A2ATask[]>;
  delete(taskId: string): Promise<void>;
}

export interface TaskStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: TaskStatus;
  /** True on the last event of the interaction: the stream ends after it */
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  /** The parts extend the artifact with the same id sent before instead of replacing it */
  append?: boolean;
  /** The artifact is complete */
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/** What a `message/stream` or `tasks/resubscribe` stream carries in each event. */
export type A2AStreamEvent = A2ATask | A2AMessage | TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/** What `message/send` returns: the task, or a direct reply message. */
export type SendMessageResult = A2ATask | A2AMessage;

export interface AgentRunResult {
  output: string;
  structured?: unknown;
  requiresInput?: boolean;
  /**
   * `paused` when tool calls wait for approval or tools asked questions: the task goes to
   * `input-required` with the calls in a tool approval request data part and the questions in an
   * interrupt request data part, and the decisions and answers resume the run
   */
  status?: 'completed' | 'paused';
  pendingApprovals?: readonly ToolApprovalRequest[];
  /** What a paused run waits on: approvals (`kind: 'approval'`) and questions of its tools */
  interrupts?: readonly RunInterrupt[];
  /**
   * The checkpoint of a paused run. The task keeps it and resumes exactly this run from it, so a
   * newer run on the same thread never takes the answers meant for this one
   */
  checkpoint?: RunCheckpoint;
  runId: string;
  agentId: string;
  threadId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
  toolCalls: ReadonlyArray<{ name: string; arguments: unknown }>;
}

export interface CogitatorLike {
  run(
    agent: unknown,
    options: {
      input: string;
      signal?: AbortSignal;
      stream?: boolean;
      onToken?: (token: string) => void;
      threadId?: string;
      timeout?: number;
      loadHistory?: boolean;
      /** The caller the run acts for, so thread and memory access is scoped to them */
      userId?: string;
    }
  ): Promise<AgentRunResult>;
  /**
   * Continue a run paused for tool approvals or questions, with the client's decisions and
   * answers: from the paused run's `checkpoint` when the run returned one, else from the thread
   * it paused in. Without it a task waiting on either fails when the client answers
   */
  resume?(
    agent: unknown,
    target: RunCheckpoint | string,
    options: {
      decisions?: Record<string, ToolApprovalDecision>;
      defaultDecision?: ToolApprovalDecision;
      /** Answers to the questions of the run's tools, by interrupt id */
      responses?: Record<string, unknown>;
      signal?: AbortSignal;
      stream?: boolean;
      onToken?: (token: string) => void;
      timeout?: number;
      userId?: string;
    }
  ): Promise<AgentRunResult>;
  /**
   * The run paused in a thread, if any. With it a task checks that the run it waits on still
   * waits before resuming it, and ends the task when a newer run on the thread moved on
   */
  pausedRun?(threadId: string): Promise<{ runId: string } | undefined>;
  /**
   * Ends the run paused in a thread without going on, its waiting calls answered as declined
   * with `reason`. With it a task whose question expired lifts the pause right away, instead of
   * leaving it to the next run of the context
   */
  cancelPause?(threadId: string, options: { userId?: string; reason?: string }): Promise<boolean>;
}

/** Who an authenticated A2A request comes from. */
export interface A2ACaller {
  userId: string;
}

export interface A2AAuthConfig {
  type: 'bearer' | 'apiKey';
  /**
   * Checks the credentials. Return the caller to keep each user's tasks,
   * contexts and memory apart; `true` admits the request without a user
   * (every such caller shares the same tasks), `false` rejects it.
   */
  validate: (credentials: string) => Promise<boolean | A2ACaller>;
  /** Header carrying the API key when `type` is 'apiKey' (default: 'x-api-key') */
  headerName?: string;
}

export interface A2AServerConfig {
  agents: Record<string, Agent>;
  cogitator: CogitatorLike;
  /**
   * Path of the JSON-RPC endpoint the framework adapters serve, relative to
   * where they are mounted (default: '/a2a'). Must start with '/'. Each agent
   * also gets its own endpoint at `<basePath>/<agent name>`.
   */
  basePath?: string;
  taskStore?: TaskStore;
  /**
   * Absolute URL of the JSON-RPC endpoint the Agent Cards advertise. Without it the framework
   * adapters derive it from the request that fetches the card. Set it when the server runs behind
   * a proxy that changes the host or the path. Other agents than the first are advertised at
   * `<cardUrl>/<agent name>`.
   */
  cardUrl?: string;
  /** The version of the agents the cards advertise (default: '1.0.0') */
  agentVersion?: string;
  /** The organization the cards name as provider */
  provider?: AgentProvider;
  auth?: A2AAuthConfig;
  pushNotificationStore?: PushNotificationStore;
  /**
   * Signs every Agent Card with a JWS in its `signatures`: with a private key (ES256, RS256,
   * PS256 or EdDSA) over the JCS of the card's A2A 1.0 form, which any A2A 1.0 client verifies
   * with the public key, or (deprecated) with a shared HMAC secret.
   */
  cardSigning?: AgentCardSigningConfig | LegacyCardSigningConfig;
  /**
   * The protocol versions the server speaks (default: both, `['1.0', '0.3']`). A request names
   * its version in the `A2A-Version` header, and one without it speaks 0.3.
   */
  protocolVersions?: readonly A2AProtocolVersion[];
  /**
   * Path of the A2A 1.0 HTTP+JSON (REST) binding the framework adapters serve, relative to
   * where they are mounted (default: `<basePath>/rest`). `false` turns it off.
   */
  restPath?: string | false;
  /**
   * Extensions the agents support besides the built-in Cogitator ones, declared in their cards.
   * A message without a `required` one in its `A2A-Extensions` header is refused (-32008).
   */
  extensions?: AgentExtension[];
  extendedCardGenerator?: (agentName: string) => AgentCard;
  allowPrivateUrls?: boolean;
  /**
   * How often the framework adapters write an SSE comment on a streaming response
   * while the run is silent, in milliseconds, so a proxy (nginx closes after 60 s) or the
   * runtime (Bun after 10 s) does not cut a run that waits on a slow tool. Default: 5000.
   * `0` turns heartbeats off.
   */
  sseHeartbeatMs?: number;
  /**
   * The longest run, in ms, a client may ask for with `configuration.timeout` for an agent
   * without its own `timeout` (default: 120000, the Cogitator run default). A client can only
   * shorten a run: its timeout is capped by the agent's `timeout`, or by this value.
   */
  maxRunTimeoutMs?: number;
}

/** The JWS algorithms a Cogitator server signs Agent Cards with. */
export type AgentCardSigningAlgorithm = 'ES256' | 'RS256' | 'PS256' | 'EdDSA';

/** Signing of Agent Cards with a private key (A2A 1.0, section 8.4). */
export interface AgentCardSigningConfig {
  /** ES256 takes a P-256 key, RS256 and PS256 an RSA key, EdDSA an Ed25519 or Ed448 key */
  alg: AgentCardSigningAlgorithm;
  /** The private key: PEM, a private JWK, or a `KeyObject` */
  privateKey: string | JsonWebKey | KeyObject;
  /** The key id clients look the public key up by (`kid` of the JWS header) */
  kid: string;
  /** The URL of the JWKS that holds the public key (`jku` of the JWS header) */
  jku?: string;
  /** Serve the public key as a JWKS at `/.well-known/jwks.json` (default: false) */
  publishJwks?: boolean;
}

/** @deprecated Signing with a shared HMAC secret: clients need the secret to verify. Use `AgentCardSigningConfig`. */
export interface LegacyCardSigningConfig {
  algorithm?: 'HS256' | 'hmac-sha256';
  secret: string;
}

export interface PushNotificationStore {
  create(taskId: string, config: PushNotificationConfig): Promise<PushNotificationConfig>;
  get(taskId: string, configId: string): Promise<PushNotificationConfig | null>;
  list(taskId: string): Promise<PushNotificationConfig[]>;
  delete(taskId: string, configId: string): Promise<void>;
}

export interface A2AClientConfig {
  headers?: Record<string, string>;
  timeout?: number;
  /**
   * Path of the Agent Card relative to the base URL (default: '/.well-known/agent-card.json',
   * falling back to the pre-v0.3 '/.well-known/agent.json')
   */
  agentCardPath?: string;
  /**
   * Path of the JSON-RPC endpoint relative to the base URL. Without it the client sends requests
   * to the `url` the Agent Card names, as the A2A specification requires.
   */
  rpcPath?: string;
  /**
   * The agent to talk to on a Cogitator server that hosts several: the name it is registered
   * under in the server's `agents`. The client then uses that agent's own card and endpoint.
   */
  agentName?: string;
  /**
   * The protocol version to speak (default: 'auto', A2A 1.0 when the Agent Card offers it, else
   * 0.3). '1.0' fails against a server without a 1.0 interface, '0.3' keeps to JSON-RPC 0.3.
   */
  protocolVersion?: 'auto' | A2AProtocolVersion;
  /**
   * The A2A 1.0 binding to use when the card offers both (default: the first the card lists).
   * A2A 0.3 always goes over JSON-RPC.
   */
  transport?: 'JSONRPC' | 'HTTP+JSON';
  /** Extension URIs to ask for on every request (`A2A-Extensions`, `X-A2A-Extensions` in 0.3) */
  extensions?: string[];
}
