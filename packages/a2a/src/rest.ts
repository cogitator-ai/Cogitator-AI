import type { A2AOperations } from './operations.js';
import { A2AError, invalidParams, methodNotFound } from './errors.js';
import { dispatchV1, streamV1, type V1RequestScope } from './v1/json-rpc.js';
import type { V1StreamResponse } from './v1/types.js';
import { toRestError } from './v1/errors.js';
import { A2A_VERSION_HEADER } from './version.js';

/** A request of the A2A 1.0 HTTP+JSON binding, as `A2AServer.handleRest` takes it. */
export interface A2ARestRequest {
  method: string;
  /** The path relative to `restPath`, percent-encoded as it came, e.g. `/tasks/task_1:cancel` */
  path: string;
  query?: URLSearchParams;
  /** The parsed JSON body; undefined when there is none */
  body?: unknown;
  /** The credential `getAuthToken` extracted */
  authToken?: string;
  /** The extension URIs of the `A2A-Extensions` header */
  extensions?: readonly string[];
  /** Absolute URL the framework adapter is mounted at, for the cards a request returns */
  baseUrl?: string;
  /** Aborted when the client disconnects */
  signal?: AbortSignal;
}

/**
 * What the HTTP+JSON binding answers: a JSON body (errors as `google.rpc.Status` with their HTTP
 * status), no body (204), or a stream of events for SSE.
 */
export type A2ARestResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'empty'; status: number }
  | { kind: 'stream'; events: AsyncGenerator<V1StreamResponse> };

type RouteName =
  | 'SendMessage'
  | 'SendStreamingMessage'
  | 'GetTask'
  | 'ListTasks'
  | 'CancelTask'
  | 'SubscribeToTask'
  | 'CreateTaskPushNotificationConfig'
  | 'GetTaskPushNotificationConfig'
  | 'ListTaskPushNotificationConfigs'
  | 'DeleteTaskPushNotificationConfig'
  | 'GetExtendedAgentCard';

interface RestRoute {
  method: RouteName;
  tenant?: string;
  taskId?: string;
  configId?: string;
}

function decode(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * The method a path names without a tenant, by the `google.api.http` bindings of the proto:
 * `/message:send`, `/tasks/{id}`, `/tasks/{id}:cancel`, `/tasks/{task_id}/pushNotificationConfigs`
 * and so on. The custom verb (`:cancel`) is read from the raw segment, before decoding.
 */
function matchUntenanted(httpMethod: string, segments: readonly string[]): RestRoute | null {
  const [first, second, third, fourth, ...rest] = segments;
  if (rest.length > 0) return null;
  if (segments.length === 1) {
    if (first === 'message:send' && httpMethod === 'POST') return { method: 'SendMessage' };
    if (first === 'message:stream' && httpMethod === 'POST') {
      return { method: 'SendStreamingMessage' };
    }
    if (first === 'tasks' && httpMethod === 'GET') return { method: 'ListTasks' };
    if (first === 'extendedAgentCard' && httpMethod === 'GET') {
      return { method: 'GetExtendedAgentCard' };
    }
    return null;
  }
  if (first !== 'tasks' || second === undefined) return null;
  if (segments.length === 2) {
    const verb = /^(.*):(cancel|subscribe)$/.exec(second);
    if (verb) {
      const taskId = decode(verb[1]);
      if (!taskId) return null;
      if (verb[2] === 'cancel' && httpMethod === 'POST') return { method: 'CancelTask', taskId };
      if (verb[2] === 'subscribe' && (httpMethod === 'GET' || httpMethod === 'POST')) {
        return { method: 'SubscribeToTask', taskId };
      }
      return null;
    }
    const taskId = decode(second);
    return taskId && httpMethod === 'GET' ? { method: 'GetTask', taskId } : null;
  }
  if (third !== 'pushNotificationConfigs') return null;
  const taskId = decode(second);
  if (!taskId) return null;
  if (fourth === undefined) {
    if (httpMethod === 'POST') return { method: 'CreateTaskPushNotificationConfig', taskId };
    if (httpMethod === 'GET') return { method: 'ListTaskPushNotificationConfigs', taskId };
    return null;
  }
  const configId = decode(fourth);
  if (!configId) return null;
  if (httpMethod === 'GET') return { method: 'GetTaskPushNotificationConfig', taskId, configId };
  if (httpMethod === 'DELETE') {
    return { method: 'DeleteTaskPushNotificationConfig', taskId, configId };
  }
  return null;
}

/**
 * The method a path names, with or without its leading `/{tenant}`. A first segment that is a
 * tenant (`isTenant`) is read as one first, so an agent named `tasks` gets `GET /tasks/tasks` as
 * its task list, and a path that names no method under that tenant still reads untenanted.
 */
export function matchRestRoute(
  httpMethod: string,
  path: string,
  isTenant: (name: string) => boolean = () => false
): RestRoute | null {
  const segments = path.split('/').slice(1);
  if (segments.length === 0 || segments.some((segment) => segment === '')) return null;
  const method = httpMethod.toUpperCase();
  const tenant = decode(segments[0]);
  const tenanted = () => {
    const route = tenant ? matchUntenanted(method, segments.slice(1)) : null;
    return route && tenant ? { ...route, tenant } : null;
  };
  if (tenant && isTenant(tenant)) {
    const route = tenanted();
    if (route) return route;
  }
  return matchUntenanted(method, segments) ?? tenanted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The query parameters of the 1.0 requests that are booleans, in both ProtoJSON spellings */
const BOOLEAN_QUERY_FIELDS = new Set(['includeArtifacts', 'include_artifacts']);

/**
 * Query parameters as request fields: the first value of each, `true`/`false` as booleans for the
 * boolean fields only, so a string such as a `contextId` of `true` stays a string
 */
function queryParams(query: URLSearchParams | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of query ?? []) {
    if (key === A2A_VERSION_HEADER || key in params) continue;
    params[key] =
      BOOLEAN_QUERY_FIELDS.has(key) && (value === 'true' || value === 'false')
        ? value === 'true'
        : value;
  }
  return params;
}

/**
 * The params of a route: the body (POST) or the query (GET, DELETE), with the path's fields
 * bound over them. A `tenant` in the body or query that differs from the path's is refused.
 */
function routeParams(route: RestRoute, request: A2ARestRequest): Record<string, unknown> {
  const source =
    request.method.toUpperCase() === 'POST' ? request.body : queryParams(request.query);
  if (source !== undefined && source !== null && !isRecord(source)) {
    throw new A2AError(invalidParams('the request body must be a JSON object'));
  }
  const params: Record<string, unknown> = { ...(source ?? {}) };
  if (route.tenant !== undefined) {
    const stated = params.tenant;
    if (typeof stated === 'string' && stated !== '' && stated !== route.tenant) {
      const description = `is "${stated}", but the path names tenant "${route.tenant}"`;
      throw new A2AError(invalidParams(`tenant: ${description}`), {
        fieldViolations: [{ field: 'tenant', description }],
      });
    }
    params.tenant = route.tenant;
  }
  switch (route.method) {
    case 'GetTask':
    case 'CancelTask':
    case 'SubscribeToTask':
      params.id = route.taskId;
      break;
    case 'CreateTaskPushNotificationConfig':
    case 'ListTaskPushNotificationConfigs':
      params.taskId = route.taskId;
      break;
    case 'GetTaskPushNotificationConfig':
    case 'DeleteTaskPushNotificationConfig':
      params.taskId = route.taskId;
      params.id = route.configId;
      break;
    default:
      break;
  }
  return params;
}

function errorResponse(error: unknown, context: string): A2ARestResponse {
  const { status, body } = toRestError(error, context);
  return { kind: 'json', status, body };
}

/**
 * Serve one request of the HTTP+JSON binding (A2A 1.0, section 11) through the same operations
 * as JSON-RPC: the method its path and HTTP method name, its params from the body or the query
 * with the path's fields bound over them. 201 answers a created push config, 204 a deletion.
 */
export async function handleRestRequest(
  operations: A2AOperations,
  request: A2ARestRequest
): Promise<A2ARestResponse> {
  const route = matchRestRoute(request.method, request.path, (name) => operations.hasAgent(name));
  if (!route) {
    return errorResponse(
      new A2AError(methodNotFound(`${request.method.toUpperCase()} ${request.path}`)),
      'route'
    );
  }

  let scope: V1RequestScope;
  let params: Record<string, unknown>;
  try {
    scope = {
      caller: await operations.authenticate(request.authToken),
      extensions: request.extensions ?? [],
      ...(request.baseUrl && { baseUrl: request.baseUrl }),
    };
    params = routeParams(route, request);
  } catch (error) {
    return errorResponse(error, `${route.method} failed`);
  }

  if (route.method === 'SendStreamingMessage' || route.method === 'SubscribeToTask') {
    return {
      kind: 'stream',
      events: streamV1(operations, route.method, params, scope, request.signal),
    };
  }

  try {
    const result = await dispatchV1(operations, route.method, params, scope);
    if (route.method === 'DeleteTaskPushNotificationConfig') return { kind: 'empty', status: 204 };
    return {
      kind: 'json',
      status: route.method === 'CreateTaskPushNotificationConfig' ? 201 : 200,
      body: result,
    };
  } catch (error) {
    return errorResponse(error, `${route.method} failed`);
  }
}
