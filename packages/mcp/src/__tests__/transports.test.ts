import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class StdioClientTransport {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;

    constructor(opts: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }) {
      this.command = opts.command;
      this.args = opts.args;
      this.env = opts.env;
      this.cwd = opts.cwd;
    }
  }
  return { StdioClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPClientTransport {
    url: URL;
    opts?: { requestInit?: RequestInit };

    constructor(url: URL, opts?: { requestInit?: RequestInit }) {
      this.url = url;
      this.opts = opts;
    }
  }
  return { StreamableHTTPClientTransport };
});

import { createStdioTransport, createHttpTransport } from '../client/transports';

describe('createStdioTransport', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  it('creates transport with command and args', () => {
    const transport = createStdioTransport({
      command: 'node',
      args: ['server.js'],
    }) as unknown as { command: string; args: string[] };

    expect(transport.command).toBe('node');
    expect(transport.args).toEqual(['server.js']);
  });

  it('creates transport with cwd', () => {
    const transport = createStdioTransport({
      command: 'node',
      cwd: '/tmp/workdir',
    }) as unknown as { cwd: string };

    expect(transport.cwd).toBe('/tmp/workdir');
  });

  it('merges custom env with process.env', () => {
    process.env.EXISTING_VAR = 'from_process';
    process.env.OVERRIDE_VAR = 'process_value';

    const transport = createStdioTransport({
      command: 'node',
      env: {
        CUSTOM_VAR: 'custom',
        OVERRIDE_VAR: 'custom_value',
      },
    }) as unknown as { env: Record<string, string> };

    expect(transport.env.CUSTOM_VAR).toBe('custom');
    expect(transport.env.OVERRIDE_VAR).toBe('custom_value');
    expect(transport.env.EXISTING_VAR).toBe('from_process');
  });

  it('does not set env when no custom env provided', () => {
    const transport = createStdioTransport({
      command: 'node',
    }) as unknown as { env: Record<string, string> | undefined };

    expect(transport.env).toBeUndefined();
  });
});

describe('createHttpTransport', () => {
  it('creates transport with URL', () => {
    const transport = createHttpTransport({
      url: 'http://localhost:3000/mcp',
    }) as unknown as { url: URL };

    expect(transport.url.href).toBe('http://localhost:3000/mcp');
  });

  it('passes headers via requestInit', () => {
    const transport = createHttpTransport({
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer token123' },
    }) as unknown as { opts?: { requestInit?: { headers: Record<string, string> } } };

    expect(transport.opts?.requestInit?.headers).toEqual({
      Authorization: 'Bearer token123',
    });
  });

  it('does not set requestInit when no headers', () => {
    const transport = createHttpTransport({
      url: 'http://localhost:3000/mcp',
    }) as unknown as { opts?: { requestInit?: RequestInit } };

    expect(transport.opts?.requestInit).toBeUndefined();
  });
});
