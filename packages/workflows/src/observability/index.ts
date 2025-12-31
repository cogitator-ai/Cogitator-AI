/**
 * @cogitator-ai/workflows - Observability module
 *
 * Provides distributed tracing and metrics collection for workflow execution.
 *
 * Features:
 * - W3C Trace Context propagation
 * - OpenTelemetry-compatible span export (OTLP, Jaeger, Zipkin)
 * - Prometheus-compatible metrics export
 * - Per-workflow and per-node metrics
 * - Token usage and cost tracking
 */

export {
  WorkflowTracer,
  createTracer,
  getGlobalTracer,
  setGlobalTracer,
} from './tracer';

export {
  WorkflowMetricsCollector,
  createMetricsCollector,
  getGlobalMetrics,
  setGlobalMetrics,
} from './metrics';

export {
  type SpanExporterInstance,
  type ExporterConfig,
  ConsoleSpanExporter,
  OTLPSpanExporter,
  ZipkinSpanExporter,
  CompositeSpanExporter,
  NoopSpanExporter,
  createSpanExporter,
} from './exporters';

export {
  TRACE_PARENT_HEADER,
  TRACE_STATE_HEADER,
  BAGGAGE_HEADER,

  SERVICE_NAME,
  SERVICE_VERSION,
  SERVICE_INSTANCE_ID,

  WORKFLOW_NAME,
  WORKFLOW_ID,
  WORKFLOW_RUN_ID,
  WORKFLOW_VERSION,
  WORKFLOW_ENTRY_POINT,
  WORKFLOW_NODE_COUNT,
  WORKFLOW_STATUS,

  NODE_NAME,
  NODE_TYPE,
  NODE_INDEX,
  NODE_RETRY_COUNT,
  NODE_TIMEOUT,
  NODE_DURATION,
  NODE_STATUS,

  LLM_SYSTEM,
  LLM_REQUEST_MODEL,
  LLM_RESPONSE_MODEL,
  LLM_REQUEST_MAX_TOKENS,
  LLM_REQUEST_TEMPERATURE,
  LLM_REQUEST_TOP_P,
  LLM_USAGE_INPUT_TOKENS,
  LLM_USAGE_OUTPUT_TOKENS,
  LLM_USAGE_TOTAL_TOKENS,
  LLM_USAGE_COST,

  TOOL_NAME,
  TOOL_PARAMETERS,
  TOOL_RESULT,
  TOOL_DURATION,
  TOOL_SUCCESS,

  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  ERROR_CODE,

  RETRY_ATTEMPT,
  RETRY_MAX,
  RETRY_DELAY,
  CIRCUIT_BREAKER_STATE,
  COMPENSATION_TRIGGERED,
  COMPENSATION_NODE,
  DEAD_LETTER_QUEUE,

  APPROVAL_ID,
  APPROVAL_TYPE,
  APPROVAL_STATUS,
  APPROVAL_TIMEOUT,
  APPROVAL_ASSIGNEE,

  TIMER_TYPE,
  TIMER_DELAY,
  TIMER_CRON,
  TIMER_SCHEDULED_AT,
  TIMER_FIRED_AT,

  SUBWORKFLOW_NAME,
  SUBWORKFLOW_DEPTH,
  SUBWORKFLOW_PARENT_ID,

  TRIGGER_TYPE,
  TRIGGER_ID,
  TRIGGER_SOURCE,
  WEBHOOK_PATH,
  WEBHOOK_METHOD,
  CRON_EXPRESSION,
  CRON_NEXT_RUN,

  workflowSpanAttributes,
  nodeSpanAttributes,
  llmSpanAttributes,
  toolSpanAttributes,
  errorSpanAttributes,
  retrySpanAttributes,
} from './span-attributes';
