/**
 * Answering what an MCP server asks a client for during a call (`inputRequests` of protocol
 * 2026-07-28, and `elicitation/create` of earlier revisions): elicitation forms and URLs, asked
 * through the run of the call (`context.interrupt()`), else the client's elicitation handler
 */

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import type { ToolContext } from '@cogitator-ai/types';
import { z } from 'zod';
import type {
  MCPAskedInput,
  MCPElicitRequest,
  MCPElicitResult,
  MCPElicitUrlRequest,
  MCPElicitationHandler,
  MCPElicitationSource,
} from '../types';

/** Who answers the input requests of one call */
export interface InputAnswerer {
  source: MCPElicitationSource;
  interrupt?: ToolContext['interrupt'];
  handler?: MCPElicitationHandler;
  /** What the call asked through its run so far, in order: a run answers its questions in order */
  ledger: MCPAskedInput[];
}

const FormParamsSchema = z.looseObject({
  mode: z.literal('form').optional(),
  message: z.string(),
  requestedSchema: z.looseObject({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});

const UrlParamsSchema = z.looseObject({
  mode: z.literal('url'),
  message: z.string(),
  url: z.string(),
});

const InputRequestSchema = z.looseObject({
  method: z.string(),
  params: z.unknown().optional(),
});

const URL_DONE_SCHEMA = {
  type: 'object',
  properties: { done: { type: 'boolean', title: 'I opened the page and finished there' } },
  required: ['done'],
} as const;

/** The elicitation request of an `elicitation/create` params object */
export function toElicitRequest(params: unknown): MCPElicitRequest | MCPElicitUrlRequest {
  const url = UrlParamsSchema.safeParse(params);
  if (url.success) return { mode: 'url', message: url.data.message, url: url.data.url };
  const form = FormParamsSchema.safeParse(params);
  if (!form.success) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid elicitation request: ${z.prettifyError(form.error)}`
    );
  }
  return {
    mode: 'form',
    message: form.data.message,
    schema: form.data.requestedSchema as MCPElicitRequest['schema'],
  };
}

/** The answers to `inputRequests`, by their keys, as `inputResponses` carries them */
export async function answerInputRequests(
  inputRequests: Readonly<Record<string, unknown>>,
  answerer: InputAnswerer
): Promise<Record<string, MCPElicitResult>> {
  const responses: Record<string, MCPElicitResult> = {};
  for (const [key, entry] of Object.entries(inputRequests)) {
    const parsed = InputRequestSchema.safeParse(entry);
    if (!parsed.success || parsed.data.method !== 'elicitation/create') {
      const method = parsed.success ? parsed.data.method : 'an unknown request';
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `The MCP server asks for ${method}, which this client does not support`
      );
    }
    const request = toElicitRequest(parsed.data.params);
    responses[key] = await answerElicitation(request, answerer, `call:${answerer.ledger.length}`);
  }
  return responses;
}

/**
 * The answer to one elicitation: asked through the call's run when it has one (the run pauses
 * until the person answers, and declining ends the call), else from the handler, else declined
 */
export async function answerElicitation(
  request: MCPElicitRequest | MCPElicitUrlRequest,
  answerer: InputAnswerer,
  key: string
): Promise<MCPElicitResult> {
  const { interrupt, handler, source } = answerer;
  if (interrupt) {
    if (!answerer.ledger.some((entry) => entry.key === key)) answerer.ledger.push({ key, request });
    const details = { server: source.server, ...(source.tool && { tool: source.tool }) };
    if (request.mode === 'url') {
      const answer = await interrupt({
        reason: 'mcp_elicitation_url',
        message: `${request.message}\n\n${request.url}`,
        responseSchema: URL_DONE_SCHEMA,
        details: { ...details, mode: 'url', url: request.url },
      });
      return isRecord(answer) && answer.done === true
        ? { action: 'accept', content: {} }
        : { action: 'decline' };
    }
    const answer = await interrupt({
      reason: 'mcp_elicitation',
      message: request.message,
      responseSchema: request.schema,
      details: { ...details, mode: 'form' },
    });
    return { action: 'accept', content: isRecord(answer) ? answer : {} };
  }
  if (handler) return handler(request, source);
  return { action: 'decline' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
