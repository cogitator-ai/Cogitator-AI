import type { JsonRpcError } from '../json-rpc.js';
import { A2A_ERROR_CODES, A2AError, clientJsonRpcError, v1ErrorCode } from '../errors.js';
import type { FieldViolation } from '../errors.js';
import type { V1ErrorDetail, V1ErrorInfo, V1RestErrorBody } from './types.js';

/** The `domain` of the `google.rpc.ErrorInfo` of A2A errors. */
export const A2A_ERROR_DOMAIN = 'a2a-protocol.org';

/** The `domain` of errors only a Cogitator server reports, such as a missing credential. */
export const COGITATOR_ERROR_DOMAIN = 'cogitator.app';

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';
const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';

interface ErrorKind {
  reason: string;
  /** The HTTP status of the HTTP+JSON binding (A2A 1.0, section 5.4) */
  httpStatus: number;
  /** The `google.rpc.Code` name the HTTP+JSON binding reports in `status` */
  status: string;
  domain: string;
}

const ERROR_KINDS: Record<number, ErrorKind> = {
  [A2A_ERROR_CODES.parseError]: kind('PARSE_ERROR', 400, 'INVALID_ARGUMENT'),
  [A2A_ERROR_CODES.invalidRequest]: kind('INVALID_REQUEST', 400, 'INVALID_ARGUMENT'),
  [A2A_ERROR_CODES.methodNotFound]: kind('METHOD_NOT_FOUND', 404, 'NOT_FOUND'),
  [A2A_ERROR_CODES.invalidParams]: kind('INVALID_PARAMS', 400, 'INVALID_ARGUMENT'),
  [A2A_ERROR_CODES.internalError]: kind('INTERNAL_ERROR', 500, 'INTERNAL'),
  [A2A_ERROR_CODES.taskNotFound]: kind('TASK_NOT_FOUND', 404, 'NOT_FOUND'),
  [A2A_ERROR_CODES.taskNotCancelable]: kind('TASK_NOT_CANCELABLE', 400, 'FAILED_PRECONDITION'),
  [A2A_ERROR_CODES.pushNotificationNotSupported]: kind(
    'PUSH_NOTIFICATION_NOT_SUPPORTED',
    400,
    'FAILED_PRECONDITION'
  ),
  [A2A_ERROR_CODES.unsupportedOperation]: kind('UNSUPPORTED_OPERATION', 400, 'FAILED_PRECONDITION'),
  [A2A_ERROR_CODES.contentTypeNotSupported]: kind(
    'CONTENT_TYPE_NOT_SUPPORTED',
    400,
    'INVALID_ARGUMENT'
  ),
  [A2A_ERROR_CODES.invalidAgentResponse]: kind('INVALID_AGENT_RESPONSE', 500, 'INTERNAL'),
  [A2A_ERROR_CODES.authenticatedExtendedCardNotConfigured]: kind(
    'EXTENDED_AGENT_CARD_NOT_CONFIGURED',
    400,
    'FAILED_PRECONDITION'
  ),
  [A2A_ERROR_CODES.extensionSupportRequired]: kind(
    'EXTENSION_SUPPORT_REQUIRED',
    400,
    'FAILED_PRECONDITION'
  ),
  [A2A_ERROR_CODES.versionNotSupported]: kind('VERSION_NOT_SUPPORTED', 400, 'FAILED_PRECONDITION'),
  [A2A_ERROR_CODES.unauthorized]: {
    reason: 'UNAUTHENTICATED',
    httpStatus: 401,
    status: 'UNAUTHENTICATED',
    domain: COGITATOR_ERROR_DOMAIN,
  },
};

function kind(reason: string, httpStatus: number, status: string): ErrorKind {
  return { reason, httpStatus, status, domain: A2A_ERROR_DOMAIN };
}

const UNKNOWN_KIND: ErrorKind = kind('INTERNAL_ERROR', 500, 'INTERNAL');

/** `google.rpc.ErrorInfo.metadata` holds strings: other values are written as JSON. */
function errorInfoMetadata(data: unknown): Record<string, string> | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const entries = Object.entries(data as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]): [string, string] => [
      key,
      typeof value === 'string'
        ? value
        : Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? value.join(',')
          : JSON.stringify(value),
    ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function details(
  code: number,
  data: unknown,
  violations: readonly FieldViolation[] | undefined
): V1ErrorDetail[] {
  const { reason, domain } = ERROR_KINDS[code] ?? UNKNOWN_KIND;
  const metadata = errorInfoMetadata(data);
  const info: V1ErrorInfo = {
    '@type': ERROR_INFO_TYPE,
    reason,
    domain,
    ...(metadata && { metadata }),
  };
  return violations?.length
    ? [
        info,
        {
          '@type': BAD_REQUEST_TYPE,
          fieldViolations: violations.map(({ field, description }) => ({ field, description })),
        },
      ]
    : [info];
}

/**
 * An error as an A2A 1.0 JSON-RPC error: the 1.0 code of its meaning, and in `data` a
 * `google.rpc.ErrorInfo` with the error's details as metadata, plus a `google.rpc.BadRequest`
 * naming the fields that failed validation. Errors of the server itself are logged with `context`
 * and reported as a bare internal error, as in 0.3.
 */
export function toV1JsonRpcError(error: unknown, context: string): JsonRpcError {
  const base = clientJsonRpcError(error, context);
  const code = v1ErrorCode(base);
  const violations = error instanceof A2AError ? error.fieldViolations : undefined;
  return { code, message: base.message, data: details(code, base.data, violations) };
}

/** The HTTP status an A2A 1.0 error code is answered with by the HTTP+JSON binding. */
export function httpStatusOf(code: number): number {
  return (ERROR_KINDS[code] ?? UNKNOWN_KIND).httpStatus;
}

/**
 * An error as the HTTP+JSON binding answers it: the HTTP status of its code and a
 * `google.rpc.Status` body whose details are those of the JSON-RPC error.
 */
export function toRestError(
  error: unknown,
  context: string
): { status: number; body: V1RestErrorBody } {
  const rpcError = toV1JsonRpcError(error, context);
  const errorKind = ERROR_KINDS[rpcError.code] ?? UNKNOWN_KIND;
  return {
    status: errorKind.httpStatus,
    body: {
      error: {
        code: errorKind.httpStatus,
        status: errorKind.status,
        message: rpcError.message,
        details: Array.isArray(rpcError.data) ? (rpcError.data as V1ErrorDetail[]) : [],
      },
    },
  };
}

/** A REST error body without an A2A error behind it, e.g. an unknown route. */
export function restErrorBody(
  httpStatus: number,
  status: string,
  message: string
): V1RestErrorBody {
  return { error: { code: httpStatus, status, message, details: [] } };
}

const CODE_BY_REASON: Record<string, number> = Object.fromEntries(
  Object.entries(ERROR_KINDS).map(([code, { reason }]) => [reason, Number(code)])
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JSON-RPC error a client raises for an HTTP+JSON error response: the code of the
 * `ErrorInfo` reason, else the code the HTTP status stands for. Undefined when the body is no
 * A2A error.
 */
export function jsonRpcErrorFromRest(httpStatus: number, body: unknown): JsonRpcError | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const error = body.error;
  const detailList = Array.isArray(error.details) ? error.details : [];
  const info = detailList.find(
    (detail): detail is V1ErrorInfo => isRecord(detail) && detail['@type'] === ERROR_INFO_TYPE
  );
  const code =
    (info && CODE_BY_REASON[info.reason]) ??
    (httpStatus === 401
      ? A2A_ERROR_CODES.unauthorized
      : httpStatus === 404
        ? A2A_ERROR_CODES.taskNotFound
        : httpStatus >= 500
          ? A2A_ERROR_CODES.internalError
          : A2A_ERROR_CODES.invalidParams);
  return {
    code,
    message: typeof error.message === 'string' ? error.message : `HTTP ${httpStatus}`,
    ...(detailList.length > 0 && { data: detailList }),
  };
}
