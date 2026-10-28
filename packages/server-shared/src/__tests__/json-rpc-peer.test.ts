import { describe, it, expect, vi } from 'vitest';
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcCallError,
  JsonRpcMessageSchema,
  JsonRpcParseError,
  JsonRpcPeer,
  createNotification,
  createRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  jsonRpcIdOf,
  parseJsonRpcMessage,
  type JsonRpcMessage,
} from '../index';

describe('createNotification', () => {
  it('builds a message without an id', () => {
    expect(createNotification('turn/started', { turnId: 't1' })).toEqual({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { turnId: 't1' },
    });
    expect(createNotification('initialized')).toEqual({ jsonrpc: '2.0', method: 'initialized' });
  });
});

describe('JSON_RPC_ERROR_CODES', () => {
  it('holds the five standard codes', () => {
    expect(JSON_RPC_ERROR_CODES).toEqual({
      parseError: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internalError: -32603,
    });
  });
});

describe('parseJsonRpcMessage', () => {
  it('reads requests, notifications and responses', () => {
    const request = parseJsonRpcMessage({ jsonrpc: '2.0', method: 'a', params: {}, id: 1 });
    const notification = parseJsonRpcMessage({ jsonrpc: '2.0', method: 'b' });
    const success = parseJsonRpcMessage({ jsonrpc: '2.0', result: null, id: 'x' });
    const failure = parseJsonRpcMessage({
      jsonrpc: '2.0',
      error: { code: -32601, message: 'nope' },
      id: null,
    });
    expect(Array.isArray(request)).toBe(false);
    expect(isJsonRpcNotification(request as JsonRpcMessage)).toBe(false);
    expect(isJsonRpcResponse(request as JsonRpcMessage)).toBe(false);
    expect(isJsonRpcNotification(notification as JsonRpcMessage)).toBe(true);
    expect(isJsonRpcResponse(success as JsonRpcMessage)).toBe(true);
    expect(isJsonRpcResponse(failure as JsonRpcMessage)).toBe(true);
  });

  it('requires the version by default', () => {
    expect(() => parseJsonRpcMessage({ method: 'a', id: 1 })).toThrow(JsonRpcParseError);
  });

  it('fills in a missing version when told to be lenient', () => {
    expect(parseJsonRpcMessage({ method: 'a', id: 1 }, { requireVersion: false })).toEqual({
      jsonrpc: '2.0',
      method: 'a',
      id: 1,
    });
  });

  it('refuses a wrong version even when lenient', () => {
    expect(() =>
      parseJsonRpcMessage({ jsonrpc: '1.0', method: 'a', id: 1 }, { requireVersion: false })
    ).toThrow(JsonRpcParseError);
  });

  it('refuses params that are neither an object nor an array', () => {
    expect(() => parseJsonRpcMessage({ jsonrpc: '2.0', method: 'a', params: 3, id: 1 })).toThrow(
      JsonRpcParseError
    );
  });

  it('refuses a response with neither result nor error', () => {
    expect(() => parseJsonRpcMessage({ jsonrpc: '2.0', id: 1 })).toThrow(JsonRpcParseError);
  });

  it('reads a batch and refuses an empty one', () => {
    const batch = parseJsonRpcMessage([
      { jsonrpc: '2.0', method: 'a', id: 1 },
      { jsonrpc: '2.0', method: 'b' },
    ]);
    expect(batch).toHaveLength(2);
    expect(() => parseJsonRpcMessage([])).toThrow(JsonRpcParseError);
  });

  it('answers invalid messages with invalidRequest', () => {
    try {
      parseJsonRpcMessage('nope');
      expect.unreachable();
    } catch (error) {
      expect((error as JsonRpcParseError).code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
    }
  });

  it('agrees with JsonRpcMessageSchema', () => {
    expect(JsonRpcMessageSchema.safeParse(createRequest(1, 'a', [1])).success).toBe(true);
    expect(JsonRpcMessageSchema.safeParse({ method: 'a' }).success).toBe(false);
  });
});

describe('jsonRpcIdOf', () => {
  it('finds a valid id and falls back to null', () => {
    expect(jsonRpcIdOf({ id: 4 })).toBe(4);
    expect(jsonRpcIdOf({ id: { nested: true } })).toBeNull();
    expect(jsonRpcIdOf('x')).toBeNull();
  });
});

/** Two peers wired to each other, with what each one sent */
function pair() {
  const sentByA: unknown[] = [];
  const sentByB: unknown[] = [];
  const a: JsonRpcPeer = new JsonRpcPeer({
    send: (message) => {
      sentByA.push(message);
      void b.receive(JSON.parse(JSON.stringify(message)));
    },
  });
  const b: JsonRpcPeer = new JsonRpcPeer({
    send: (message) => {
      sentByB.push(message);
      void a.receive(JSON.parse(JSON.stringify(message)));
    },
  });
  return { a, b, sentByA, sentByB };
}

describe('JsonRpcPeer', () => {
  it('answers a request with its handler result', async () => {
    const { a, b } = pair();
    b.onRequest('add', (params) => {
      const { x, y } = params as { x: number; y: number };
      return x + y;
    });
    await expect(a.request('add', { x: 2, y: 3 })).resolves.toBe(5);
    expect(a.pending).toBe(0);
  });

  it('answers undefined results with null', async () => {
    const { a, b } = pair();
    b.onRequest('noop', () => undefined);
    await expect(a.request('noop')).resolves.toBeNull();
  });

  it('rejects with JsonRpcCallError when the other side answers with an error', async () => {
    const { a, b } = pair();
    b.onRequest('fail', () => {
      throw new JsonRpcCallError({ code: -32010, message: 'Thread busy', data: { id: 't' } });
    });
    const failure = a.request('fail');
    await expect(failure).rejects.toBeInstanceOf(JsonRpcCallError);
    await expect(failure).rejects.toMatchObject({ code: -32010, data: { id: 't' } });
  });

  it('hides what an unexpected error says unless describeError is set', async () => {
    const { a, b } = pair();
    b.onRequest('boom', () => {
      throw new Error('secret path /etc');
    });
    await expect(a.request('boom')).rejects.toMatchObject({
      code: JSON_RPC_ERROR_CODES.internalError,
      message: 'Internal error',
    });
  });

  it('describes unexpected errors with describeError', async () => {
    const sent: JsonRpcMessage[] = [];
    const peer = new JsonRpcPeer({
      send: (message) => {
        sent.push(...(Array.isArray(message) ? message : [message]));
      },
      describeError: (error, context) => ({
        code: -32000,
        message: `${context.method}: ${(error as Error).message}`,
      }),
    });
    peer.onRequest('boom', () => {
      throw new Error('bad');
    });
    await peer.receive({ jsonrpc: '2.0', method: 'boom', id: 7 });
    expect(sent).toEqual([
      { jsonrpc: '2.0', error: { code: -32000, message: 'boom: bad' }, id: 7 },
    ]);
  });

  it('answers unknown methods with methodNotFound', async () => {
    const { a } = pair();
    await expect(a.request('missing')).rejects.toMatchObject({
      code: JSON_RPC_ERROR_CODES.methodNotFound,
    });
  });

  it('delivers notifications to their handler and answers nothing', async () => {
    const { a, b, sentByB } = pair();
    const heard = vi.fn();
    b.onNotification('turn/started', heard);
    await a.notify('turn/started', { turnId: 't1' });
    await vi.waitFor(() => expect(heard).toHaveBeenCalledOnce());
    expect(heard.mock.calls[0]?.[0]).toEqual({ turnId: 't1' });
    expect(sentByB).toEqual([]);
  });

  it('reports a notification handler that throws', async () => {
    const onError = vi.fn();
    const peer = new JsonRpcPeer({ send: () => undefined, onError });
    peer.onNotification('n', () => {
      throw new Error('handler broke');
    });
    await peer.receive({ jsonrpc: '2.0', method: 'n' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'handler broke' }));
  });

  it('accepts messages without a version by default', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer({ send: (message) => void sent.push(message) });
    peer.onRequest('ping', () => 'pong');
    await peer.receive({ method: 'ping', id: 1 });
    expect(sent).toEqual([{ jsonrpc: '2.0', result: 'pong', id: 1 }]);
  });

  it('refuses messages without a version with requireVersion', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer({
      send: (message) => void sent.push(message),
      requireVersion: true,
    });
    peer.onRequest('ping', () => 'pong');
    await peer.receive({ method: 'ping', id: 1 });
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: 'Invalid JSON-RPC message' },
        id: 1,
      },
    ]);
  });

  it('answers a batch with one batch, notifications left out', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer({ send: (message) => void sent.push(message) });
    peer.onRequest('echo', (params) => params);
    const heard = vi.fn();
    peer.onNotification('note', heard);
    await peer.receive([
      { jsonrpc: '2.0', method: 'echo', params: [1], id: 1 },
      { jsonrpc: '2.0', method: 'note' },
      { jsonrpc: '2.0', method: 'missing', id: 2 },
      { nonsense: true },
    ]);
    expect(heard).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      { jsonrpc: '2.0', result: [1], id: 1 },
      {
        jsonrpc: '2.0',
        error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: 'Method not found: missing' },
        id: 2,
      },
      {
        jsonrpc: '2.0',
        error: { code: JSON_RPC_ERROR_CODES.invalidRequest, message: 'Invalid JSON-RPC message' },
        id: null,
      },
    ]);
  });

  it('sends nothing for a batch of notifications only', async () => {
    const send = vi.fn();
    const peer = new JsonRpcPeer({ send });
    await peer.receive([
      { jsonrpc: '2.0', method: 'a' },
      { jsonrpc: '2.0', method: 'b' },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers an empty batch with invalidRequest', async () => {
    const send = vi.fn();
    const peer = new JsonRpcPeer({ send });
    await peer.receive([]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        error: expect.objectContaining({ code: JSON_RPC_ERROR_CODES.invalidRequest }),
      })
    );
  });

  it('settles requests answered inside a batch', async () => {
    const outgoing: JsonRpcMessage[] = [];
    const peer = new JsonRpcPeer({
      send: (message) => {
        outgoing.push(...(Array.isArray(message) ? message : [message]));
      },
    });
    const first = peer.request('a');
    const second = peer.request('b');
    const ids = outgoing.map((message) => (message as { id: number }).id);
    await peer.receive([
      { jsonrpc: '2.0', result: 'A', id: ids[0] },
      { jsonrpc: '2.0', error: { code: 1, message: 'B failed' }, id: ids[1] },
    ]);
    await expect(first).resolves.toBe('A');
    await expect(second).rejects.toMatchObject({ code: 1, message: 'B failed' });
  });

  it('answers requests outside their handler with respond and respondError', async () => {
    const sent: unknown[] = [];
    const peer = new JsonRpcPeer({ send: (message) => void sent.push(message) });
    await peer.respond(3, { ok: true });
    await peer.respondError(null, {
      code: JSON_RPC_ERROR_CODES.parseError,
      message: 'Parse error',
    });
    expect(sent).toEqual([
      { jsonrpc: '2.0', result: { ok: true }, id: 3 },
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
    ]);
  });

  it('reports a response to no request', async () => {
    const onError = vi.fn();
    const peer = new JsonRpcPeer({ send: () => undefined, onError });
    await peer.receive({ jsonrpc: '2.0', result: 1, id: 99 });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects pending requests on close and refuses new ones', async () => {
    const peer = new JsonRpcPeer({ send: () => undefined });
    const waiting = peer.request('slow');
    expect(peer.pending).toBe(1);
    peer.close(new Error('connection lost'));
    await expect(waiting).rejects.toThrow('connection lost');
    expect(peer.pending).toBe(0);
    expect(peer.closed).toBe(true);
    await expect(peer.request('later')).rejects.toThrow('connection lost');
    await expect(peer.notify('later')).rejects.toThrow('connection lost');
  });

  it('aborts running handlers on close and sends nothing after', async () => {
    const send = vi.fn();
    const peer = new JsonRpcPeer({ send });
    let seen: AbortSignal | undefined;
    peer.onRequest('long', (_params, context) => {
      seen = context.signal;
      return new Promise((resolve) => context.signal.addEventListener('abort', resolve));
    });
    const handled = peer.receive({ jsonrpc: '2.0', method: 'long', id: 1 });
    peer.close();
    await handled;
    expect(seen?.aborted).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a request whose signal aborts and drops its late answer', async () => {
    const outgoing: JsonRpcMessage[] = [];
    const onError = vi.fn();
    const peer = new JsonRpcPeer({
      send: (message) => void outgoing.push(message as JsonRpcMessage),
      onError,
    });
    const controller = new AbortController();
    const waiting = peer.request('slow', undefined, { signal: controller.signal });
    controller.abort(new Error('user stopped'));
    await expect(waiting).rejects.toThrow('user stopped');
    await peer.receive({ jsonrpc: '2.0', result: 1, id: (outgoing[0] as { id: number }).id });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects a request after its timeout', async () => {
    vi.useFakeTimers();
    try {
      const peer = new JsonRpcPeer({ send: () => undefined });
      const waiting = peer.request('slow', undefined, { timeoutMs: 50 });
      const caught = waiting.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60);
      expect(await caught).toBeInstanceOf(Error);
      expect(peer.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a request the transport could not send', async () => {
    const peer = new JsonRpcPeer({
      send: () => {
        throw new Error('pipe closed');
      },
    });
    await expect(peer.request('a')).rejects.toThrow('pipe closed');
    expect(peer.pending).toBe(0);
  });

  it('removes a handler with the function it returned', async () => {
    const { a, b } = pair();
    const off = b.onRequest('x', () => 1);
    await expect(a.request('x')).resolves.toBe(1);
    off();
    await expect(a.request('x')).rejects.toMatchObject({
      code: JSON_RPC_ERROR_CODES.methodNotFound,
    });
  });
});
