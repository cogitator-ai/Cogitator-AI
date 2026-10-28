import type { AgentExtension } from './types.js';
import { A2AError, invalidParams } from './errors.js';
import { TOOL_APPROVAL_REQUEST_KIND, TOOL_APPROVAL_RESPONSE_KIND } from './approvals.js';
import { INTERRUPT_REQUEST_KIND, INTERRUPT_RESPONSE_KIND } from './questions.js';

/** The header a client lists the extensions it asks for in, and the server the ones it used (A2A 1.0). */
export const A2A_EXTENSIONS_HEADER = 'A2A-Extensions';

/** The A2A 0.3 name of `A2A-Extensions`. */
export const LEGACY_EXTENSIONS_HEADER = 'X-A2A-Extensions';

const COGITATOR_EXTENSIONS = 'https://cogitator.app/a2a/extensions';

/**
 * Cogitator extension: a run paused for tool approvals sends the calls in a
 * `tool-approval-request` data part, and a `tool-approval-response` data part answers them.
 */
export const TOOL_APPROVALS_EXTENSION = `${COGITATOR_EXTENSIONS}/tool-approvals/v1`;

/**
 * Cogitator extension: a run whose tools asked questions sends them in an `interrupt-request`
 * data part, and an `interrupt-response` data part answers them.
 */
export const INTERRUPTS_EXTENSION = `${COGITATOR_EXTENSIONS}/interrupts/v1`;

/**
 * Cogitator extension: a client shortens the run of its task. A2A 0.3 clients set
 * `configuration.timeout`, A2A 1.0 clients `metadata[RUN_TIMEOUT_EXTENSION].timeoutMs`.
 */
export const RUN_TIMEOUT_EXTENSION = `${COGITATOR_EXTENSIONS}/run-timeout/v1`;

/** The extensions every Cogitator agent supports, none of them required. */
export const COGITATOR_AGENT_EXTENSIONS: readonly AgentExtension[] = [
  {
    uri: TOOL_APPROVALS_EXTENSION,
    description:
      'Tool calls that wait for approval come as a tool-approval-request data part of an input-required task, and a tool-approval-response data part answers them.',
    required: false,
    params: { requestKind: TOOL_APPROVAL_REQUEST_KIND, responseKind: TOOL_APPROVAL_RESPONSE_KIND },
  },
  {
    uri: INTERRUPTS_EXTENSION,
    description:
      'Questions the tools of a run asked come as an interrupt-request data part of an input-required task, and an interrupt-response data part answers them by question id.',
    required: false,
    params: { requestKind: INTERRUPT_REQUEST_KIND, responseKind: INTERRUPT_RESPONSE_KIND },
  },
  {
    uri: RUN_TIMEOUT_EXTENSION,
    description:
      'A client shortens the run of its task with metadata[uri].timeoutMs on the request (configuration.timeout in A2A 0.3). It never exceeds the timeout of the agent.',
    required: false,
    params: { metadataKey: 'timeoutMs' },
  },
];

/** The extension URIs a header lists: comma-separated, trimmed, each once. */
export function parseExtensionsHeader(value: string | null | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((uri) => uri.trim())
        .filter(Boolean)
    ),
  ];
}

/** The required extensions of an agent a request did not ask for. */
export function missingRequiredExtensions(
  declared: readonly AgentExtension[],
  requested: readonly string[]
): string[] {
  return declared
    .filter((extension) => extension.required && !requested.includes(extension.uri))
    .map((extension) => extension.uri);
}

/** The extensions a request asked for that the agent supports: the ones the response names. */
export function activatedExtensions(
  declared: readonly AgentExtension[],
  requested: readonly string[]
): string[] {
  return requested.filter((uri) => declared.some((extension) => extension.uri === uri));
}

/**
 * The run time limit an A2A 1.0 request asks for with the run-timeout extension: the
 * `timeoutMs` of `metadata[RUN_TIMEOUT_EXTENSION]`. Undefined without the entry, an
 * `InvalidParamsError` when it is not a positive integer.
 */
export function runTimeoutFromMetadata(
  metadata: Record<string, unknown> | undefined
): number | undefined {
  if (!metadata || !(RUN_TIMEOUT_EXTENSION in metadata)) return undefined;
  const entry = metadata[RUN_TIMEOUT_EXTENSION];
  const timeoutMs =
    typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).timeoutMs
      : undefined;
  if (typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  const field = `metadata["${RUN_TIMEOUT_EXTENSION}"].timeoutMs`;
  const description = 'must be a positive integer of milliseconds';
  throw new A2AError(invalidParams(`${field}: ${description}`), {
    fieldViolations: [{ field, description }],
  });
}
