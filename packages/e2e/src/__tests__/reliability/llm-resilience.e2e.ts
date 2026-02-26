import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import {
  OllamaBackend,
  withRetry,
  CircuitBreaker,
  withFallback,
  CogitatorError,
  ErrorCode,
} from '@cogitator-ai/core';

function ollamaLine(content: string, done: boolean): string {
  return JSON.stringify({
    model: 'mock',
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content },
    done,
    ...(done && { prompt_eval_count: 10, eval_count: 5 }),
  });
}

let currentHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let mockServer: http.Server;
let mockPort: number;
const openSockets = new Set<net.Socket>();

describe('Reliability: LLM Resilience', () => {
  beforeAll(async () => {
    mockServer = http.createServer((req, res) => currentHandler(req, res));
    mockServer.on('connection', (socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      mockServer.listen(0, () => {
        const addr = mockServer.address();
        mockPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const socket of openSockets) {
      socket.destroy();
    }
    openSockets.clear();
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('mid-stream disconnect throws without hanging', async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(ollamaLine('Hello', false) + '\n');
      res.write(ollamaLine(' world', false) + '\n');
      setTimeout(() => res.destroy(), 10);
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });
    const chunks: string[] = [];

    await expect(async () => {
      for await (const chunk of backend.chatStream({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        if (chunk.delta.content) chunks.push(chunk.delta.content);
      }
    }).rejects.toThrow();

    expect(chunks.length).toBeGreaterThanOrEqual(0);
  }, 5000);

  it('malformed JSON lines are skipped but valid chunks still delivered', async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(ollamaLine('ok', false) + '\n');
      res.write('NOT VALID JSON\n');
      res.write(ollamaLine('', true) + '\n');
      res.end();
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });
    const chunks: string[] = [];

    for await (const chunk of backend.chatStream({
      model: 'mock',
      messages: [{ role: 'user', content: 'test' }],
    })) {
      if (chunk.delta.content) chunks.push(chunk.delta.content);
    }

    expect(chunks).toContain('ok');
  });

  it('stream of only malformed JSON throws', async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write('GARBAGE LINE 1\n');
      res.write('GARBAGE LINE 2\n');
      res.end();
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    await expect(async () => {
      for await (const _chunk of backend.chatStream({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        void _chunk;
      }
    }).rejects.toThrow(/malformed/i);
  });

  it('chat to dead server throws LLM_UNAVAILABLE with retryable', async () => {
    const backend = new OllamaBackend({ baseUrl: 'http://localhost:1' });

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
    }
  });

  it('stream to dead server throws and generator terminates', async () => {
    const backend = new OllamaBackend({ baseUrl: 'http://localhost:1' });

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
      expect(err.code).toBe(ErrorCode.LLM_UNAVAILABLE);
    }
  });

  it('server stalls mid-stream can be aborted via timeout', async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(ollamaLine('start', false) + '\n');
    };

    const backend = new OllamaBackend({ baseUrl: `http://localhost:${mockPort}` });

    const streamPromise = (async () => {
      for await (const _chunk of backend.chatStream({
        model: 'mock',
        messages: [{ role: 'user', content: 'test' }],
      })) {
        void _chunk;
      }
    })();

    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000));
    const result = await Promise.race([streamPromise.then(() => 'done' as const), timeout]);

    expect(result).toBe('timeout');
  }, 5000);

  it('withRetry retries then succeeds on 3rd attempt', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new CogitatorError({
            message: `Attempt ${attempts} failed`,
            code: ErrorCode.LLM_UNAVAILABLE,
            retryable: true,
          });
        }
        return 'success';
      },
      { maxRetries: 3, baseDelay: 10, backoff: 'constant' }
    );

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('withRetry stops immediately on non-retryable error', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new CogitatorError({
            message: 'Auth failed',
            code: ErrorCode.LLM_UNAVAILABLE,
            retryable: false,
          });
        },
        { maxRetries: 5, baseDelay: 10 }
      )
    ).rejects.toThrow('Auth failed');

    expect(attempts).toBe(1);
  });

  it('withRetry respects AbortSignal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      withRetry(
        async () => {
          throw new CogitatorError({
            message: 'fail',
            code: ErrorCode.LLM_UNAVAILABLE,
            retryable: true,
            retryAfter: 10000,
          });
        },
        { maxRetries: 10, baseDelay: 10000, signal: controller.signal }
      )
    ).rejects.toThrow(/abort/i);
  });

  it('CircuitBreaker transitions through full state machine', async () => {
    const transitions: Array<{ from: string; to: string }> = [];

    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 100,
      halfOpenRequests: 1,
      onStateChange: (from, to) => transitions.push({ from, to }),
    });

    expect(breaker.getState()).toBe('closed');

    const retryableError = new CogitatorError({
      message: 'fail',
      code: ErrorCode.LLM_UNAVAILABLE,
      retryable: true,
    });

    for (let i = 0; i < 3; i++) {
      await breaker
        .execute(() => {
          throw retryableError;
        })
        .catch(() => {});
    }
    expect(breaker.getState()).toBe('open');

    await expect(breaker.execute(() => Promise.resolve('x'))).rejects.toThrow(/circuit breaker/i);

    await new Promise((r) => setTimeout(r, 150));

    const result = await breaker.execute(() => Promise.resolve('recovered'));
    expect(result).toBe('recovered');
    expect(breaker.getState()).toBe('closed');

    const stateFlow = transitions.map((t) => `${t.from}->${t.to}`);
    expect(stateFlow).toContain('closed->open');
    expect(stateFlow).toContain('open->half-open');
    expect(stateFlow).toContain('half-open->closed');
  });

  it('withFallback uses fallback and calls onFallback', async () => {
    const fallbackCalls: Array<{ from: string; to: string }> = [];

    const result = await withFallback({
      primary: async () => {
        throw new Error('primary down');
      },
      fallbacks: [{ name: 'backup', fn: async () => 'from-backup' }],
      onFallback: (from, to, _error) => {
        fallbackCalls.push({ from, to });
      },
    });

    expect(result).toBe('from-backup');
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]).toEqual({ from: 'primary', to: 'backup' });
  });
});
