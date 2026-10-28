import type { A2ACaller, A2ATask } from '../types.js';
import type { A2AOperations, CallContext } from '../operations.js';
import type { ListTasksPage, ListTasksPageQuery } from '../list-tasks.js';
import { A2AError, methodNotFound, unsupportedOperation } from '../errors.js';
import {
  parseCancelTaskRequest,
  parseCreatePushConfigRequest,
  parseGetExtendedAgentCardRequest,
  parseGetTaskRequest,
  parseListPushConfigsRequest,
  parseListTasksRequest,
  parsePushConfigRequest,
  parseSendMessageRequest,
  parseSubscribeToTaskRequest,
} from './schema.js';
import {
  pushConfigFromV1,
  pushConfigToV1,
  sendMessageRequestFromV1,
  streamEventToV1,
  taskStateFromV1,
  taskToV1,
} from './translate.js';
import type { V1ListTasksRequest, V1ListTasksResponse, V1StreamResponse } from './types.js';

/** The A2A 1.0 JSON-RPC methods, PascalCase as the proto names them (section 9.4). */
export const V1_METHODS = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
] as const;

/** A2A 1.0 JSON-RPC methods answered with a stream of events. */
export const V1_STREAMING_METHODS: readonly string[] = ['SendStreamingMessage', 'SubscribeToTask'];

/** What an A2A 1.0 request carries besides its params. */
export interface V1RequestScope {
  caller: A2ACaller | undefined;
  extensions: readonly string[];
  baseUrl?: string;
  /** The agent the endpoint addresses, when the request came to an agent's own endpoint */
  endpointAgent?: string;
}

/** The context of a request with its tenant: the agent it addresses. */
export function v1Context(
  operations: A2AOperations,
  scope: V1RequestScope,
  tenant: string | undefined
): CallContext {
  return {
    caller: scope.caller,
    agentName: operations.agentFor(scope.endpointAgent, tenant),
    version: '1.0',
    extensions: scope.extensions,
    ...(scope.baseUrl && { baseUrl: scope.baseUrl }),
  };
}

/** A page of tasks as `ListTasks` answers it: artifacts only when asked for, then always present. */
export function listTasksResponse(
  page: ListTasksPage,
  includeArtifacts: boolean | undefined
): V1ListTasksResponse {
  return {
    tasks: page.tasks.map((task) => {
      const v1 = taskToV1(task);
      return includeArtifacts ? { ...v1, artifacts: v1.artifacts ?? [] } : v1;
    }),
    nextPageToken: page.nextPageToken,
    pageSize: page.pageSize,
    totalSize: page.totalSize,
  };
}

/** A `ListTasks` request in the internal form. */
export function listTasksQuery(request: V1ListTasksRequest): ListTasksPageQuery {
  const state = request.status ? taskStateFromV1(request.status) : undefined;
  return {
    ...(request.contextId && { contextId: request.contextId }),
    ...(state && state !== 'unknown' && { state }),
    ...(request.pageSize !== undefined && { pageSize: request.pageSize }),
    ...(request.pageToken && { pageToken: request.pageToken }),
    ...(request.historyLength !== undefined && { historyLength: request.historyLength }),
    ...(request.statusTimestampAfter && { statusTimestampAfter: request.statusTimestampAfter }),
    ...(request.includeArtifacts !== undefined && { includeArtifacts: request.includeArtifacts }),
  };
}

/** The result of an A2A 1.0 JSON-RPC method that is not streamed. */
export async function dispatchV1(
  operations: A2AOperations,
  method: string,
  params: unknown,
  scope: V1RequestScope
): Promise<unknown> {
  switch (method) {
    case 'SendMessage': {
      const request = parseSendMessageRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      const task: A2ATask = await operations.sendMessage(
        sendMessageRequestFromV1(request),
        context
      );
      return { task: taskToV1(task) };
    }
    case 'SendStreamingMessage':
    case 'SubscribeToTask':
      throw new A2AError(unsupportedOperation(`${method} streams: use handleJsonRpcStream`));
    case 'GetTask': {
      const request = parseGetTaskRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      return taskToV1(await operations.getTask(request.id, request.historyLength, context));
    }
    case 'ListTasks': {
      const request = parseListTasksRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      const page = await operations.listTasksPage(listTasksQuery(request), context);
      return listTasksResponse(page, request.includeArtifacts);
    }
    case 'CancelTask': {
      const request = parseCancelTaskRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      return taskToV1(await operations.cancelTask(request.id, context));
    }
    case 'CreateTaskPushNotificationConfig': {
      const request = parseCreatePushConfigRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      const stored = await operations.createPushConfig(
        request.taskId,
        { ...pushConfigFromV1(request), protocolVersion: '1.0' },
        context
      );
      return pushConfigToV1(stored, request.taskId);
    }
    case 'GetTaskPushNotificationConfig': {
      const request = parsePushConfigRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      const config = await operations.getPushConfig(request.taskId, request.id, context);
      return pushConfigToV1(config, request.taskId);
    }
    case 'ListTaskPushNotificationConfigs': {
      const request = parseListPushConfigsRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      const configs = await operations.listPushConfigs(request.taskId, context);
      return { configs: configs.map((config) => pushConfigToV1(config, request.taskId)) };
    }
    case 'DeleteTaskPushNotificationConfig': {
      const request = parsePushConfigRequest(params);
      const context = v1Context(operations, scope, request.tenant);
      await operations.deletePushConfig(request.taskId, request.id, context);
      return null;
    }
    case 'GetExtendedAgentCard': {
      const request = parseGetExtendedAgentCardRequest(params);
      return operations.extendedCard(v1Context(operations, scope, request.tenant));
    }
    default:
      throw new A2AError(methodNotFound(method));
  }
}

/** The events of a streamed A2A 1.0 method, each a `StreamResponse`. */
export async function* streamV1(
  operations: A2AOperations,
  method: string,
  params: unknown,
  scope: V1RequestScope,
  signal: AbortSignal | undefined
): AsyncGenerator<V1StreamResponse> {
  if (method === 'SendStreamingMessage') {
    const request = parseSendMessageRequest(params);
    const context = v1Context(operations, scope, request.tenant);
    for await (const event of operations.streamMessage(
      sendMessageRequestFromV1(request),
      context,
      signal
    )) {
      yield streamEventToV1(event);
    }
    return;
  }
  const request = parseSubscribeToTaskRequest(params);
  const context = v1Context(operations, scope, request.tenant);
  for await (const event of operations.subscribe(request.id, context, signal)) {
    yield streamEventToV1(event);
  }
}
