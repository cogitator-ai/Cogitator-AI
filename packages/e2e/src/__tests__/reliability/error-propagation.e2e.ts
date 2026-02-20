import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { OllamaBackend, Agent, CogitatorError, ErrorCode } from '@cogitator-ai/core';
import { A2AServer } from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import type { CogitatorLike } from '@cogitator-ai/a2a';
import express from 'express';

let currentHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let mockServer: http.Server;
let mockPort: number;

function jsonBody(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

describe('Reliability: Error Propagation', () => {
  beforeAll(async () => {
    mockServer = http.createServer((req, res) => currentHandler(req, res));
    await new Promise<void>((resolve) => {
      mockServer.listen(0, () => {
        const addr = mockServer.address();
        mockPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('429 maps to LLM_RATE_LIMITED with retryAfter', async () => {
    currentHandler = (_req, res) => {
      jsonBody(res, 429, { error: 'rate limited', retry_after: 30 });
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    try {
      await backend.chat({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as CogitatorError;
      expect(CogitatorError.isCogitatorError(err)).toBe(true);
      expect(err.code).toBe(ErrorCode.LLM_RATE_LIMITED);
      expect(err.retryable).toBe(true);
      expect(err.retryAfter).toBe(30000);
    }
  });

  it('500 maps to LLM_UNAVAILABLE with retryable', async () => {
    currentHandler = (_req, res) => {
      jsonBody(res, 500, { error: 'internal server error' });
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    try {
      await backend.chat({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as CogitatorError;
      expect(CogitatorError.isCogitatorError(err)).toBe(true);
      expect(err.code).toBe(ErrorCode.LLM_UNAVAILABLE);
      expect(err.retryable).toBe(true);
      expect(err.retryAfter).toBe(5000);
    }
  });

  it('401 maps to non-retryable error', async () => {
    currentHandler = (_req, res) => {
      jsonBody(res, 401, { error: 'unauthorized' });
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    try {
      await backend.chat({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as CogitatorError;
      expect(CogitatorError.isCogitatorError(err)).toBe(true);
      expect(err.code).toBe(ErrorCode.LLM_UNAVAILABLE);
      expect(err.retryable).toBe(false);
    }
  });

  it('400 with "context length exceeded" maps to LLM_CONTEXT_LENGTH_EXCEEDED', async () => {
    currentHandler = (_req, res) => {
      jsonBody(res, 400, { error: 'context length exceeded, max 4096 tokens' });
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    try {
      await backend.chat({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as CogitatorError;
      expect(CogitatorError.isCogitatorError(err)).toBe(true);
      expect(err.code).toBe(ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED);
      expect(err.retryable).toBe(false);
    }
  });

  it('404 maps to LLM_UNAVAILABLE non-retryable', async () => {
    currentHandler = (_req, res) => {
      jsonBody(res, 404, { error: 'model not found' });
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    try {
      await backend.chat({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as CogitatorError;
      expect(CogitatorError.isCogitatorError(err)).toBe(true);
      expect(err.code).toBe(ErrorCode.LLM_UNAVAILABLE);
      expect(err.retryable).toBe(false);
    }
  });

  it('agent failure propagates to A2A task as failed state', async () => {
    const failingCogitator: CogitatorLike = {
      run: async () => {
        throw new Error('Agent exploded');
      },
    };

    const agent = new Agent({
      name: 'failing-agent',
      instructions: 'This agent always fails',
      model: 'mock/model',
    });

    const a2aServer = new A2AServer({
      agents: { 'failing-agent': agent },
      cogitator: failingCogitator,
    });

    const response = await a2aServer.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{ type: 'text', text: 'do something' }],
        },
      },
    });

    const result = response as { result?: { status?: { state: string; message?: string } } };
    expect(result.result?.status?.state).toBe('failed');
    expect(result.result?.status?.message).toContain('Agent exploded');
  });

  it('SSE stream yields failed event when agent throws', async () => {
    const failingCogitator: CogitatorLike = {
      run: async () => {
        throw new Error('stream boom');
      },
    };

    const agent = new Agent({
      name: 'sse-fail-agent',
      instructions: 'This agent always fails on stream',
      model: 'mock/model',
    });

    const a2aServer = new A2AServer({
      agents: { 'sse-fail-agent': agent },
      cogitator: failingCogitator,
    });

    const app = express();
    app.use(a2aExpress(a2aServer) as any);

    const httpServer = await new Promise<http.Server>((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://localhost:${port}/a2a`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: 'fail now' }],
            },
          },
        }),
      });

      const body = await res.text();
      const events = body
        .split('\n\n')
        .filter((b) => b.trim())
        .map((block) => {
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) return null;
          const raw = dataLine.slice(6);
          if (raw === '[DONE]') return { done: true };
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        })
        .filter(Boolean);

      const failedEvent = events.find(
        (e: any) => e.type === 'status-update' && e.status?.state === 'failed'
      );
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).status.message).toContain('stream boom');
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('streaming 429 throws LLM_RATE_LIMITED', async () => {
    currentHandler = (_req, res) => {
      jsonBody(res, 429, { error: 'too many requests', retry_after: 15 });
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    try {
      for await (const _chunk of backend.chatStream({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        void _chunk;
      }
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as CogitatorError;
      expect(CogitatorError.isCogitatorError(err)).toBe(true);
      expect(err.code).toBe(ErrorCode.LLM_RATE_LIMITED);
      expect(err.retryable).toBe(true);
      expect(err.retryAfter).toBe(15000);
    }
  });
});
