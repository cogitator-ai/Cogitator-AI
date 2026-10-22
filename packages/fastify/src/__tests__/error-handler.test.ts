import { describe, it, expect, vi } from 'vitest';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { errorHandler } from '../hooks/error-handler.js';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

function mockReply(sent = false) {
  let statusCode = 200;
  let body: unknown = null;
  const sentHeaders: Record<string, string> = {};
  const reply = {
    sent,
    status: vi.fn((code: number) => {
      statusCode = code;
      return reply;
    }),
    headers: vi.fn((values: Record<string, string>) => {
      Object.assign(sentHeaders, values);
      return reply;
    }),
    send: vi.fn((b: unknown) => {
      body = b;
      return reply;
    }),
    _status: () => statusCode,
    _body: () => body,
    _headers: sentHeaders,
  };
  return reply as unknown as FastifyReply & typeof reply;
}

function mockRequest() {
  return {
    log: { error: vi.fn(), warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeFastifyError(message: string, code?: string): FastifyError {
  const err = new Error(message) as FastifyError;
  if (code) err.code = code;
  return err;
}

describe('errorHandler', () => {
  it('does nothing if reply already sent', () => {
    const reply = mockReply(true);
    const request = mockRequest();
    errorHandler(makeFastifyError('test'), request, reply);
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('returns 500 for generic errors', () => {
    const reply = mockReply();
    const request = mockRequest();
    errorHandler(makeFastifyError('something broke'), request, reply);
    expect(reply._status()).toBe(500);
    expect(reply._body()).toEqual({
      error: { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR },
    });
  });

  it('logs unhandled error via request.log', () => {
    const reply = mockReply();
    const request = mockRequest();
    const err = makeFastifyError('boom');
    errorHandler(err, request, reply);
    expect(request.log.error as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ err }),
      expect.any(String)
    );
  });

  it('maps CogitatorError to correct status code', () => {
    const reply = mockReply();
    const request = mockRequest();
    const err = new CogitatorError({
      message: 'agent not found',
      code: ErrorCode.AGENT_NOT_FOUND,
    }) as unknown as FastifyError;
    errorHandler(err, request, reply);
    expect(reply._status()).toBe(404);
    expect(reply._body()).toEqual({
      error: { message: 'agent not found', code: ErrorCode.AGENT_NOT_FOUND },
    });
  });

  it('answers a CogitatorError with its own status and Retry-After', () => {
    const reply = mockReply();
    const err = new CogitatorError({
      message: 'provider down',
      code: ErrorCode.LLM_UNAVAILABLE,
      statusCode: 502,
      retryAfter: 30_000,
    }) as unknown as FastifyError;
    errorHandler(err, mockRequest(), reply);
    expect(reply._status()).toBe(502);
    expect(reply._headers).toEqual({ 'Retry-After': '30' });
    expect(reply._body()).toEqual({
      error: { message: 'provider down', code: ErrorCode.LLM_UNAVAILABLE },
    });
  });

  it('answers a swarm that ran out of time with 504 RUN_TIMEOUT', () => {
    const reply = mockReply();
    const err = Object.assign(new Error('Swarm timed out after 5000ms'), {
      name: 'SwarmTimeoutError',
    }) as FastifyError;
    errorHandler(err, mockRequest(), reply);
    expect(reply._status()).toBe(504);
    expect(reply._body()).toEqual({
      error: { message: 'Swarm timed out after 5000ms', code: ErrorCode.RUN_TIMEOUT },
    });
  });
});
