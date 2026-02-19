import type { Agent } from '@cogitator-ai/types';

export type TaskState =
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export const TERMINAL_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;

export function isTerminalState(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface FilePart {
  type: 'file';
  uri: string;
  mimeType: string;
  size?: number;
  name?: string;
}

export interface DataPart {
  type: 'data';
  mimeType: string;
  data: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: Part[];
  taskId?: string;
  contextId?: string;
  referenceTaskIds?: string[];
}

export interface Artifact {
  id: string;
  parts: Part[];
  mimeType?: string;
}

export interface A2AErrorDetail {
  code: number;
  message: string;
  data?: unknown;
}

export interface TaskStatus {
  state: TaskState;
  timestamp: string;
  message?: string;
  errorDetails?: A2AErrorDetail;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: TaskStatus;
  history: A2AMessage[];
  artifacts: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface AgentProvider {
  name: string;
  url?: string;
  contactEmail?: string;
}

export interface A2ACapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  extendedAgentCard?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  inputModes: string[];
  outputModes: string[];
  examples?: string[];
}

export type SecurityScheme =
  | { type: 'apiKey'; location: 'header' | 'query' | 'cookie'; parameterName: string }
  | { type: 'http'; scheme: 'basic' | 'bearer' }
  | { type: 'oauth2'; flows: Record<string, unknown> }
  | { type: 'openIdConnect'; connectUrl: string };

export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  provider?: AgentProvider;
  capabilities: A2ACapabilities;
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Record<string, string[]>[];
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  blocking?: boolean;
  timeout?: number;
}

export interface TaskFilter {
  contextId?: string;
  state?: TaskState;
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
  type: 'status-update';
  taskId: string;
  status: TaskStatus;
  timestamp: string;
}

export interface TaskArtifactUpdateEvent {
  type: 'artifact-update';
  taskId: string;
  artifact: Artifact;
  timestamp: string;
}

export type A2AStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export interface AgentRunResult {
  output: string;
  structured?: unknown;
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
    }
  ): Promise<AgentRunResult>;
}

export interface A2AAuthConfig {
  type: 'bearer' | 'apiKey';
  validate: (credentials: string) => Promise<boolean>;
}

export interface A2AServerConfig {
  agents: Record<string, Agent>;
  cogitator: CogitatorLike;
  basePath?: string;
  taskStore?: TaskStore;
  cardUrl?: string;
  auth?: A2AAuthConfig;
}

export interface A2AClientConfig {
  headers?: Record<string, string>;
  timeout?: number;
  agentCardPath?: string;
  rpcPath?: string;
}
