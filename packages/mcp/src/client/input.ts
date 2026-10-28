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
  /** What the call asked so far, in order: a run answers its questions in order */
  ledger: MCPAskedInput[];
  /** The keys of the ledger this run of the call asked already */
  consumed: Set<string>;
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

/** An input request of a round, with the key the call's ledger keeps it under */
export interface PlannedInput {
  /** The request's key in the round's `inputRequests` */
  key: string;
  /** Its key in the ledger of the call (`call:<n>`) */
  asked: string;
  request: MCPElicitRequest | MCPElicitUrlRequest;
}

/**
 * The elicitations of a round's `inputRequests`, added to the call's ledger in order
 *
 * @throws ProtocolError for a request of another kind, which this client never declares
 */
export function planInputRequests(
  inputRequests: Readonly<Record<string, unknown>>,
  answerer: InputAnswerer
): PlannedInput[] {
  const planned: PlannedInput[] = [];
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
    const asked = `call:${answerer.ledger.length}`;
    answerer.ledger.push({ key: asked, request });
    planned.push({ key, asked, request });
  }
  return planned;
}

/**
 * The answers to a planned round, by the round's keys. Every question of the ledger this run of
 * the call has not asked yet is asked first, in order, so a run that resumed reads the answers of
 * its earlier questions before those of the round
 */
export async function answerPlanned(
  planned: readonly Pick<PlannedInput, 'key' | 'asked'>[],
  answerer: InputAnswerer
): Promise<Record<string, MCPElicitResult>> {
  const byAsked = new Map(planned.map((entry) => [entry.asked, entry.key]));
  const responses: Record<string, MCPElicitResult> = {};
  for (const entry of [...answerer.ledger]) {
    if (answerer.consumed.has(entry.key)) continue;
    const roundKey = byAsked.get(entry.key);
    if (!answerer.interrupt && roundKey === undefined) continue;
    const answer = await answerElicitation(entry.request, answerer);
    answerer.consumed.add(entry.key);
    if (roundKey !== undefined) responses[roundKey] = answer;
  }
  return responses;
}

/** The answers to `inputRequests`, by their keys, as `inputResponses` carries them */
export async function answerInputRequests(
  inputRequests: Readonly<Record<string, unknown>>,
  answerer: InputAnswerer
): Promise<Record<string, MCPElicitResult>> {
  return answerPlanned(planInputRequests(inputRequests, answerer), answerer);
}

/**
 * The answer to one elicitation: asked through the call's run when it has one (the run pauses
 * until the person answers, and declining ends the call), else from the handler, else declined
 */
export async function answerElicitation(
  request: MCPElicitRequest | MCPElicitUrlRequest,
  answerer: InputAnswerer
): Promise<MCPElicitResult> {
  const { interrupt, handler, source } = answerer;
  if (interrupt) {
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
