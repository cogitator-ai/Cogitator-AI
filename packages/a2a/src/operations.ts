import type { A2ACaller, A2ATask, MessageSendParams, PushNotificationConfig } from './types.js';
import type { TaskEvent } from './task-manager.js';
import type { ListTasksPage, ListTasksPageQuery } from './list-tasks.js';
import type { A2AProtocolVersion } from './version.js';
import type { V1AgentCard } from './v1/types.js';

/** Who and what one request addresses, once its version, caller and agent are known. */
export interface CallContext {
  caller: A2ACaller | undefined;
  /** The agent the request addresses: by its endpoint, its tenant, or the first agent */
  agentName: string;
  version: A2AProtocolVersion;
  /** The extension URIs the client asked for */
  extensions: readonly string[];
  /** Absolute URL the framework adapter is mounted at, for the URLs of cards */
  baseUrl?: string;
}

/**
 * What the server does, apart from the wire format: the A2A 0.3 JSON-RPC dispatcher, the A2A 1.0
 * JSON-RPC dispatcher and the HTTP+JSON binding all parse their requests into the internal model
 * and call these.
 */
export interface A2AOperations {
  /** Whether the server hosts an agent under this name, a tenant */
  hasAgent(name: string): boolean;
  /** The caller of a request, or `unauthorized` */
  authenticate(authToken: string | undefined): Promise<A2ACaller | undefined>;
  /**
   * The agent an A2A 1.0 request addresses: the agent of its endpoint, else its `tenant`, else
   * the first agent. A tenant that differs from the endpoint's agent is `InvalidParams`.
   */
  agentFor(endpointAgent: string | undefined, tenant: string | undefined): string;
  sendMessage(params: MessageSendParams, context: CallContext): Promise<A2ATask>;
  streamMessage(
    params: MessageSendParams,
    context: CallContext,
    signal?: AbortSignal
  ): AsyncGenerator<A2ATask | TaskEvent>;
  getTask(
    taskId: string,
    historyLength: number | undefined,
    context: CallContext
  ): Promise<A2ATask>;
  cancelTask(taskId: string, context: CallContext): Promise<A2ATask>;
  subscribe(
    taskId: string,
    context: CallContext,
    signal?: AbortSignal
  ): AsyncGenerator<A2ATask | TaskEvent>;
  listTasksPage(query: ListTasksPageQuery, context: CallContext): Promise<ListTasksPage>;
  createPushConfig(
    taskId: string,
    config: PushNotificationConfig,
    context: CallContext
  ): Promise<PushNotificationConfig>;
  getPushConfig(
    taskId: string,
    configId: string | undefined,
    context: CallContext
  ): Promise<PushNotificationConfig>;
  listPushConfigs(taskId: string, context: CallContext): Promise<PushNotificationConfig[]>;
  deletePushConfig(taskId: string, configId: string, context: CallContext): Promise<void>;
  /** The authenticated extended card of the context's agent in its A2A 1.0 form */
  extendedCard(context: CallContext): V1AgentCard;
}
