/**
 * Standard span attributes for workflow tracing
 * Based on OpenTelemetry semantic conventions + custom workflow attributes
 */

// W3C Trace Context header names
export const TRACE_PARENT_HEADER = 'traceparent';
export const TRACE_STATE_HEADER = 'tracestate';
export const BAGGAGE_HEADER = 'baggage';

// Service attributes
export const SERVICE_NAME = 'service.name';
export const SERVICE_VERSION = 'service.version';
export const SERVICE_INSTANCE_ID = 'service.instance.id';

// Workflow attributes
export const WORKFLOW_NAME = 'workflow.name';
export const WORKFLOW_ID = 'workflow.id';
export const WORKFLOW_RUN_ID = 'workflow.run.id';
export const WORKFLOW_VERSION = 'workflow.version';
export const WORKFLOW_ENTRY_POINT = 'workflow.entry_point';
export const WORKFLOW_NODE_COUNT = 'workflow.node_count';
export const WORKFLOW_STATUS = 'workflow.status';

// Node attributes
export const NODE_NAME = 'node.name';
export const NODE_TYPE = 'node.type';
export const NODE_INDEX = 'node.index';
export const NODE_RETRY_COUNT = 'node.retry_count';
export const NODE_TIMEOUT = 'node.timeout';
export const NODE_DURATION = 'node.duration_ms';
export const NODE_STATUS = 'node.status';

// LLM attributes (OpenLLMetry compatible)
export const LLM_SYSTEM = 'llm.system';
export const LLM_REQUEST_MODEL = 'llm.request.model';
export const LLM_RESPONSE_MODEL = 'llm.response.model';
export const LLM_REQUEST_MAX_TOKENS = 'llm.request.max_tokens';
export const LLM_REQUEST_TEMPERATURE = 'llm.request.temperature';
export const LLM_REQUEST_TOP_P = 'llm.request.top_p';
export const LLM_USAGE_INPUT_TOKENS = 'llm.usage.input_tokens';
export const LLM_USAGE_OUTPUT_TOKENS = 'llm.usage.output_tokens';
export const LLM_USAGE_TOTAL_TOKENS = 'llm.usage.total_tokens';
export const LLM_USAGE_COST = 'llm.usage.cost';

// Tool attributes
export const TOOL_NAME = 'tool.name';
export const TOOL_PARAMETERS = 'tool.parameters';
export const TOOL_RESULT = 'tool.result';
export const TOOL_DURATION = 'tool.duration_ms';
export const TOOL_SUCCESS = 'tool.success';

// Error attributes
export const ERROR_TYPE = 'error.type';
export const ERROR_MESSAGE = 'error.message';
export const ERROR_STACK = 'error.stack';
export const ERROR_CODE = 'error.code';

// Retry/compensation attributes
export const RETRY_ATTEMPT = 'retry.attempt';
export const RETRY_MAX = 'retry.max';
export const RETRY_DELAY = 'retry.delay_ms';
export const CIRCUIT_BREAKER_STATE = 'circuit_breaker.state';
export const COMPENSATION_TRIGGERED = 'compensation.triggered';
export const COMPENSATION_NODE = 'compensation.node';
export const DEAD_LETTER_QUEUE = 'dlq.added';

// Human-in-the-loop attributes
export const APPROVAL_ID = 'approval.id';
export const APPROVAL_TYPE = 'approval.type';
export const APPROVAL_STATUS = 'approval.status';
export const APPROVAL_TIMEOUT = 'approval.timeout_ms';
export const APPROVAL_ASSIGNEE = 'approval.assignee';

// Timer attributes
export const TIMER_TYPE = 'timer.type';
export const TIMER_DELAY = 'timer.delay_ms';
export const TIMER_CRON = 'timer.cron';
export const TIMER_SCHEDULED_AT = 'timer.scheduled_at';
export const TIMER_FIRED_AT = 'timer.fired_at';

// Subworkflow attributes
export const SUBWORKFLOW_NAME = 'subworkflow.name';
export const SUBWORKFLOW_DEPTH = 'subworkflow.depth';
export const SUBWORKFLOW_PARENT_ID = 'subworkflow.parent_id';

// Trigger attributes
export const TRIGGER_TYPE = 'trigger.type';
export const TRIGGER_ID = 'trigger.id';
export const TRIGGER_SOURCE = 'trigger.source';
export const WEBHOOK_PATH = 'webhook.path';
export const WEBHOOK_METHOD = 'webhook.method';
export const CRON_EXPRESSION = 'cron.expression';
export const CRON_NEXT_RUN = 'cron.next_run';

/**
 * Build standard workflow span attributes
 */
export function workflowSpanAttributes(
  workflowName: string,
  workflowId: string,
  runId: string,
  additionalAttrs?: Record<string, unknown>
): Record<string, unknown> {
  return {
    [WORKFLOW_NAME]: workflowName,
    [WORKFLOW_ID]: workflowId,
    [WORKFLOW_RUN_ID]: runId,
    ...additionalAttrs,
  };
}

/**
 * Build standard node span attributes
 */
export function nodeSpanAttributes(
  nodeName: string,
  nodeType: string,
  nodeIndex: number,
  additionalAttrs?: Record<string, unknown>
): Record<string, unknown> {
  return {
    [NODE_NAME]: nodeName,
    [NODE_TYPE]: nodeType,
    [NODE_INDEX]: nodeIndex,
    ...additionalAttrs,
  };
}

/**
 * Build LLM span attributes from token usage
 */
export function llmSpanAttributes(
  system: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost?: number,
  additionalAttrs?: Record<string, unknown>
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    [LLM_SYSTEM]: system,
    [LLM_REQUEST_MODEL]: model,
    [LLM_USAGE_INPUT_TOKENS]: inputTokens,
    [LLM_USAGE_OUTPUT_TOKENS]: outputTokens,
    [LLM_USAGE_TOTAL_TOKENS]: inputTokens + outputTokens,
  };

  if (cost !== undefined) {
    attrs[LLM_USAGE_COST] = cost;
  }

  return { ...attrs, ...additionalAttrs };
}

/**
 * Build tool span attributes
 */
export function toolSpanAttributes(
  toolName: string,
  success: boolean,
  durationMs: number,
  additionalAttrs?: Record<string, unknown>
): Record<string, unknown> {
  return {
    [TOOL_NAME]: toolName,
    [TOOL_SUCCESS]: success,
    [TOOL_DURATION]: durationMs,
    ...additionalAttrs,
  };
}

/**
 * Build error span attributes
 */
export function errorSpanAttributes(
  error: Error,
  additionalAttrs?: Record<string, unknown>
): Record<string, unknown> {
  return {
    [ERROR_TYPE]: error.name,
    [ERROR_MESSAGE]: error.message,
    [ERROR_STACK]: error.stack,
    ...additionalAttrs,
  };
}

/**
 * Build retry span attributes
 */
export function retrySpanAttributes(
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  additionalAttrs?: Record<string, unknown>
): Record<string, unknown> {
  return {
    [RETRY_ATTEMPT]: attempt,
    [RETRY_MAX]: maxAttempts,
    [RETRY_DELAY]: delayMs,
    ...additionalAttrs,
  };
}
