import type { ToolApprovalDecision } from '@cogitator-ai/types';
import type {
  AddMessageRequest,
  AgentResumeRequest,
  AgentRunRequest,
  SwarmRunRequest,
  WorkflowRunRequest,
} from '../types.js';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const MESSAGE_ROLES: readonly AddMessageRequest['role'][] = ['user', 'assistant', 'system'];

function isMessageRole(value: unknown): value is AddMessageRequest['role'] {
  return MESSAGE_ROLES.some((role) => role === value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function parseRunFields(
  body: unknown
): ParseResult<{ input: string; context?: Record<string, unknown>; threadId?: string }> {
  if (!isRecord(body) || body.input === undefined || body.input === null || body.input === '') {
    return fail('Missing required field: input');
  }
  if (typeof body.input !== 'string') return fail('Field "input" must be a string');
  if (body.context !== undefined && !isRecord(body.context)) {
    return fail('Field "context" must be an object');
  }
  if (body.threadId !== undefined && (typeof body.threadId !== 'string' || !body.threadId)) {
    return fail('Field "threadId" must be a non-empty string');
  }

  return {
    ok: true,
    value: {
      input: body.input,
      ...(body.context !== undefined && { context: body.context }),
      ...(body.threadId !== undefined && { threadId: body.threadId }),
    },
  };
}

export function parseAgentRunRequest(body: unknown): ParseResult<AgentRunRequest> {
  return parseRunFields(body);
}

const DECISION_SHAPE = '{ approved: boolean, reason?: string }';

function parseDecision(value: unknown): ToolApprovalDecision | null {
  if (!isRecord(value) || typeof value.approved !== 'boolean') return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.approved) return { approved: true };
  return value.reason === undefined
    ? { approved: false }
    : { approved: false, reason: value.reason };
}

export function parseAgentResumeRequest(body: unknown): ParseResult<AgentResumeRequest> {
  if (!isRecord(body) || body.threadId === undefined || body.threadId === null) {
    return fail('Missing required field: threadId');
  }
  if (typeof body.threadId !== 'string' || !body.threadId.trim()) {
    return fail('Field "threadId" must be a non-empty string');
  }

  const request: AgentResumeRequest = { threadId: body.threadId };

  if (body.decisions !== undefined) {
    if (!isRecord(body.decisions)) return fail('Field "decisions" must be an object');
    const entries: Array<[string, ToolApprovalDecision]> = [];
    for (const [toolCallId, value] of Object.entries(body.decisions)) {
      const decision = parseDecision(value);
      if (!decision) return fail(`Each entry of "decisions" must be ${DECISION_SHAPE}`);
      entries.push([toolCallId, decision]);
    }
    request.decisions = Object.fromEntries(entries);
  }

  if (body.defaultDecision !== undefined) {
    const decision = parseDecision(body.defaultDecision);
    if (!decision) return fail(`Field "defaultDecision" must be ${DECISION_SHAPE}`);
    request.defaultDecision = decision;
  }

  return { ok: true, value: request };
}

export function parseSwarmRunRequest(body: unknown): ParseResult<SwarmRunRequest> {
  const parsed = parseRunFields(body);
  if (!parsed.ok) return parsed;

  const timeout = isRecord(body) ? body.timeout : undefined;
  if (timeout === undefined) return parsed;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return fail('Field "timeout" must be a positive number');
  }
  return { ok: true, value: { ...parsed.value, timeout } };
}

export function parseWorkflowRunRequest(body: unknown): ParseResult<WorkflowRunRequest> {
  if (body === undefined || body === null) return { ok: true, value: {} };
  if (!isRecord(body)) return fail('Request body must be a JSON object');

  if (body.input !== undefined && !isRecord(body.input)) {
    return fail('Field "input" must be an object');
  }

  const request: WorkflowRunRequest = {};
  if (body.input !== undefined) request.input = body.input;

  if (body.options !== undefined) {
    if (!isRecord(body.options)) return fail('Field "options" must be an object');
    const { maxConcurrency, maxIterations, checkpoint } = body.options;
    if (maxConcurrency !== undefined && !isPositiveInteger(maxConcurrency)) {
      return fail('Field "options.maxConcurrency" must be a positive integer');
    }
    if (maxIterations !== undefined && !isPositiveInteger(maxIterations)) {
      return fail('Field "options.maxIterations" must be a positive integer');
    }
    if (checkpoint !== undefined && typeof checkpoint !== 'boolean') {
      return fail('Field "options.checkpoint" must be a boolean');
    }
    request.options = {
      ...(maxConcurrency !== undefined && { maxConcurrency }),
      ...(maxIterations !== undefined && { maxIterations }),
      ...(checkpoint !== undefined && { checkpoint }),
    };
  }

  return { ok: true, value: request };
}

export function parseAddMessageRequest(body: unknown): ParseResult<AddMessageRequest> {
  if (!isRecord(body) || !body.role || !body.content) {
    return fail('Missing required fields: role, content');
  }
  if (!isMessageRole(body.role)) {
    return fail('Field "role" must be one of: user, assistant, system');
  }
  if (typeof body.content !== 'string') return fail('Field "content" must be a string');
  if (body.metadata !== undefined && !isRecord(body.metadata)) {
    return fail('Field "metadata" must be an object');
  }

  return {
    ok: true,
    value: {
      role: body.role,
      content: body.content,
      ...(body.metadata !== undefined && { metadata: body.metadata }),
    },
  };
}
