import { describe, it, expect } from 'vitest';
import {
  CogitatorError,
  ErrorCode,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type LLMBackend,
} from '@cogitator-ai/types';
import {
  backendConformanceCases,
  CONFORMANCE_FIXTURE,
  openAIChatWire,
  startFakeProvider,
  type BackendConformanceTarget,
} from '../conformance';

/**
 * A backend that sends each request to the fake provider and answers with the same text,
 * whatever the provider says.
 */
function cannedBackend(url: string, options: { ignoreSignal?: boolean } = {}): LLMBackend {
  const response: ChatResponse = {
    id: 'canned',
    content: CONFORMANCE_FIXTURE.text,
    finishReason: 'stop',
    usage: { ...CONFORMANCE_FIXTURE.usage, totalTokens: 17 },
  };
  const call = (signal: AbortSignal | undefined) =>
    fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
      ...(signal && !options.ignoreSignal && { signal }),
    });
  return {
    provider: 'canned',
    chat: (request: ChatRequest) =>
      new Promise((resolve, reject) => {
        if (options.ignoreSignal) {
          call(undefined).catch(() => undefined);
          return;
        }
        request.signal?.addEventListener('abort', () =>
          reject(
            request.signal?.reason instanceof Error ? request.signal.reason : new Error('aborted')
          )
        );
        void call(request.signal).then(
          () => resolve(response),
          () => undefined
        );
      }),
    async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      await (await call(request.signal)).text();
      yield { id: 'canned', delta: { content: response.content } };
      yield { id: 'canned', delta: {}, finishReason: 'stop', usage: response.usage };
    },
  };
}

const target = (backend: (url: string) => LLMBackend): BackendConformanceTarget => ({
  name: 'canned',
  wire: openAIChatWire,
  model: '',
  createBackend: backend,
});

function caseOf(t: BackendConformanceTarget, name: string) {
  const found = backendConformanceCases(t).find((c) => c.name === name);
  if (!found) throw new Error(`no case ${name}`);
  return found;
}

describe('backendConformanceCases', () => {
  it('lists every scenario in both modes, stream-error in streams only', () => {
    const names = backendConformanceCases(target((url) => cannedBackend(url))).map((c) => c.name);

    expect(names).toContain('tool-call-with-stop (chat)');
    expect(names).toContain('tool-call-with-stop (stream)');
    expect(names).toContain('stream-error (stream)');
    expect(names).not.toContain('stream-error (chat)');
    expect(new Set(names).size).toBe(names.length);
  });

  it('skips a scenario the wire has no answer for, saying why', () => {
    const cases = backendConformanceCases({
      ...target((url) => cannedBackend(url)),
      wire: { name: 'Plain', reply: () => undefined },
    });
    expect(cases.every((c) => c.skip === 'Plain has no such case')).toBe(true);
  });

  it('passes a backend that does what the scenario asks', async () => {
    await expect(
      caseOf(
        target((url) => cannedBackend(url)),
        'text (stream)'
      ).run()
    ).resolves.toBe(undefined);
  });

  it('fails a backend that misses the tool call', async () => {
    await expect(
      caseOf(
        target((url) => cannedBackend(url)),
        'tool-call (stream)'
      ).run()
    ).rejects.toThrow(/canned: tool-call \(stream\): a tool turn/);
  });

  it('fails a backend whose SDK retries an error that is not retryable', async () => {
    const retrying = (url: string): LLMBackend => {
      const backend = cannedBackend(url);
      return {
        ...backend,
        chat: async () => {
          await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{}' });
          await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{}' });
          throw new CogitatorError({
            message: 'quota',
            code: ErrorCode.LLM_QUOTA_EXCEEDED,
            details: { kind: 'quota' },
          });
        },
      };
    };
    await expect(caseOf(target(retrying), 'quota (chat)').run()).rejects.toThrow(
      /not retried, by the backend or its SDK/
    );
  });

  it('fails a backend that does not turn a provider error into a CogitatorError', async () => {
    await expect(
      caseOf(
        target((url) => cannedBackend(url)),
        'quota (stream)'
      ).run()
    ).rejects.toThrow(/the call fails/);
  });

  it('fails a backend that never gives up after an abort', async () => {
    const run = caseOf(
      target((url) => cannedBackend(url, { ignoreSignal: true })),
      'abort (chat)'
    ).run();
    await expect(run).rejects.toThrow(/gives up after the abort/);
  }, 10_000);
});

describe('startFakeProvider', () => {
  it('answers with the reply set and records the request', async () => {
    const provider = await startFakeProvider();
    try {
      provider.reply(() => ({ type: 'json', status: 201, body: { ok: true } }));
      const response = await fetch(`${provider.url}/v1/things?x=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-key': 'value' },
        body: JSON.stringify({ hello: 'world' }),
      });

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true });
      expect(provider.requests).toEqual([
        {
          method: 'POST',
          path: '/v1/things?x=1',
          headers: expect.objectContaining({ 'x-key': 'value' }),
          body: { hello: 'world' },
        },
      ]);
    } finally {
      await provider.close();
    }
  });

  it('streams its chunks one by one and holds a hanging stream open until the client goes', async () => {
    const provider = await startFakeProvider();
    try {
      provider.reply(() => ({
        type: 'stream',
        contentType: 'text/plain',
        chunks: ['one', 'two'],
        hang: true,
      }));
      const controller = new AbortController();
      const response = await fetch(provider.url, { signal: controller.signal });
      const reader = response.body!.getReader();
      let text = '';
      while (text.length < 'onetwo'.length) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      expect(text).toBe('onetwo');

      controller.abort();
      await provider.latestClosed();
    } finally {
      await provider.close();
    }
  });
});
