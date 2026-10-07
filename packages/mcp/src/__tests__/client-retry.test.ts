import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const state = vi.hoisted(() => ({
  instances: 0,
  connectImpl: (() => Promise.resolve()) as () => Promise<void>,
  callToolImpl: (() => Promise.resolve({ content: [] })) as (
    params: unknown,
    schema: unknown,
    options: unknown
  ) => Promise<unknown>,
  closeCalls: 0,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    constructor() {
      state.instances++;
    }
    connect = vi.fn(() => state.connectImpl());
    close = vi.fn(() => {
      state.closeCalls++;
      return Promise.resolve();
    });
    getServerCapabilities = vi.fn().mockReturnValue({ tools: {} });
    callTool = vi.fn((params: unknown, schema: unknown, options: unknown) =>
      state.callToolImpl(params, schema, options)
    );
  }
  return { Client };
});

vi.mock('../client/transports', () => ({
  createStdioTransport: vi.fn().mockReturnValue({}),
  createHttpTransport: vi.fn().mockReturnValue({}),
}));

const { MCPClient, MCPToolError, MCPToolInterruptedError } = await import('../client/mcp-client');

const fastRetry = { maxRetries: 3, initialDelay: 1, maxDelay: 5 };

beforeEach(() => {
  state.instances = 0;
  state.closeCalls = 0;
  state.connectImpl = () => Promise.resolve();
  state.callToolImpl = () => Promise.resolve({ content: [] });
});

describe('MCPClient.callTool result mapping', () => {
  it('prefers structuredContent over text content', async () => {
    state.callToolImpl = () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'summary' }],
        structuredContent: { rows: 3 },
      });
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x' });

    expect(await client.callTool('t', {})).toEqual({ rows: 3 });
  });

  it('returns null for an empty successful result', async () => {
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x' });
    expect(await client.callTool('t', {})).toBeNull();
  });

  it('throws MCPToolError for isError results and does not retry', async () => {
    const calls = vi.fn();
    state.callToolImpl = () => {
      calls();
      return Promise.resolve({ content: [{ type: 'text', text: 'denied' }], isError: true });
    };
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      retry: fastRetry,
    });

    const error = await client.callTool('t', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MCPToolError);
    expect((error as Error).message).toBe('denied');
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('forwards signal and timeout to the SDK', async () => {
    const seen: unknown[] = [];
    state.callToolImpl = (_params, _schema, options) => {
      seen.push(options);
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    };
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x' });
    const controller = new AbortController();

    await client.callTool('t', {}, { signal: controller.signal, timeout: 1234 });

    expect(seen[0]).toEqual({ signal: controller.signal, timeout: 1234 });
  });
});

describe('MCPClient retry policy', () => {
  it('does not retry deterministic protocol errors', async () => {
    const calls = vi.fn();
    state.callToolImpl = () => {
      calls();
      return Promise.reject(new McpError(ErrorCode.InvalidParams, 'bad connection string'));
    };
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      retry: fastRetry,
    });

    await expect(client.callTool('t', {})).rejects.toThrow('bad connection string');
    expect(calls).toHaveBeenCalledTimes(1);
    expect(state.instances).toBe(1);
  });

  it('retries timeouts of idempotent calls with backoff', async () => {
    let attempts = 0;
    state.callToolImpl = () => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
      }
      return Promise.resolve({ content: [{ type: 'text', text: '"done"' }] });
    };
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      retry: fastRetry,
    });

    expect(await client.callTool('t', {}, { idempotent: true })).toBe('done');
    expect(attempts).toBe(3);
  });

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController();
    const calls = vi.fn();
    state.callToolImpl = () => {
      calls();
      controller.abort();
      return Promise.reject(new Error('fetch failed'));
    };
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      retry: fastRetry,
    });

    await expect(client.callTool('t', {}, { signal: controller.signal })).rejects.toThrow(
      'fetch failed'
    );
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('shares one reconnect between concurrent calls that lose the connection', async () => {
    let healthy = false;
    state.callToolImpl = () =>
      healthy
        ? Promise.resolve({ content: [{ type: 'text', text: '1' }] })
        : Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));

    const onReconnecting = vi.fn();
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      retry: fastRetry,
      onReconnecting,
    });

    state.connectImpl = () => {
      healthy = true;
      return Promise.resolve();
    };

    const results = await Promise.all([
      client.callTool('a', {}, { idempotent: true }),
      client.callTool('b', {}, { idempotent: true }),
      client.callTool('c', {}, { idempotent: true }),
    ]);

    expect(results).toEqual([1, 1, 1]);
    expect(onReconnecting).toHaveBeenCalledTimes(1);
    expect(state.instances).toBe(2);
    expect(client.isConnected()).toBe(true);
    expect(client.isReconnecting()).toBe(false);
  });

  it('reports a permanent reconnect failure through onReconnectFailed', async () => {
    state.callToolImpl = () =>
      Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    const onReconnectFailed = vi.fn();
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      retry: fastRetry,
      onReconnectFailed,
    });
    state.connectImpl = () => Promise.reject(new Error('ECONNREFUSED'));

    await expect(client.callTool('t', {}, { idempotent: true })).rejects.toThrow();
    expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });
});

describe('MCPClient calls that must not run twice', () => {
  it('does not send a timed-out call of a side-effect tool again', async () => {
    const calls = vi.fn();
    state.callToolImpl = () => {
      calls();
      return Promise.reject(
        new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout: 60000 })
      );
    };
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x', retry: fastRetry });

    const error = await client.callTool('deploy_service', {}).catch((e: unknown) => e);

    expect(calls).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(MCPToolInterruptedError);
    expect((error as InstanceType<typeof MCPToolInterruptedError>).reason).toBe('timeout');
    expect((error as Error).message).toBe(
      'MCP tool "deploy_service" timed out after 60000ms. It was not called again, since the ' +
        'server may have run it and the tool is not marked idempotent or read-only.'
    );
  });

  it('does not send a call again after losing the connection mid-call', async () => {
    const calls = vi.fn();
    state.callToolImpl = () => {
      calls();
      return Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    };
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x', retry: fastRetry });

    const error = await client.callTool('send_email', {}).catch((e: unknown) => e);

    expect(calls).toHaveBeenCalledTimes(1);
    expect((error as InstanceType<typeof MCPToolInterruptedError>).reason).toBe('connection-lost');
    expect(state.instances).toBe(1);
  });

  it('does not retry unknown errors of a side-effect tool', async () => {
    const calls = vi.fn();
    state.callToolImpl = () => {
      calls();
      return Promise.reject(new Error('socket hang up'));
    };
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x', retry: fastRetry });

    await expect(client.callTool('charge_card', {})).rejects.toThrow('socket hang up');
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('restores a lost connection before sending the next call', async () => {
    let healthy = false;
    state.callToolImpl = () =>
      healthy
        ? Promise.resolve({ content: [{ type: 'text', text: '"sent"' }] })
        : Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x', retry: fastRetry });

    await expect(client.callTool('send_email', {})).rejects.toThrow(MCPToolInterruptedError);
    state.connectImpl = () => {
      healthy = true;
      return Promise.resolve();
    };

    expect(await client.callTool('send_email', {})).toBe('sent');
    expect(state.instances).toBe(2);
  });
});

describe('MCPClient lifecycle', () => {
  it('closes the transport when connect fails without a timeout', async () => {
    state.connectImpl = () => Promise.reject(new Error('spawn ENOENT'));

    await expect(MCPClient.connect({ transport: 'stdio', command: 'missing' })).rejects.toThrow(
      'spawn ENOENT'
    );
    expect(state.closeCalls).toBe(1);
  });

  it('close() releases the transport even after the connection dropped', async () => {
    state.callToolImpl = () =>
      Promise.reject(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    const client = await MCPClient.connect({
      transport: 'stdio',
      command: 'x',
      autoReconnect: false,
      retry: fastRetry,
    });

    await expect(client.callTool('t', {})).rejects.toThrow(MCPToolInterruptedError);
    expect(client.isConnected()).toBe(false);

    await client.close();
    expect(state.closeCalls).toBe(1);
  });

  it('rejects operations and reconnects after close()', async () => {
    const client = await MCPClient.connect({ transport: 'stdio', command: 'x' });
    await client.close();

    await expect(client.callTool('t', {})).rejects.toThrow('closed');
    await expect(client.reconnect()).rejects.toThrow('closed');
  });
});
