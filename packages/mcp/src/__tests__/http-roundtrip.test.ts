import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:net';
import { z } from 'zod';
import type { Tool, ToolSchema } from '@cogitator-ai/types';
import { MCPServer } from '../server/mcp-server';
import { MCPClient, MCPToolError } from '../client/mcp-client';

function makeTool<T>(
  name: string,
  parameters: z.ZodType<T>,
  execute: (params: T) => Promise<unknown>
): Tool<T> {
  return {
    name,
    description: `${name} tool`,
    parameters,
    execute: (params) => execute(params),
    toJSON: (): ToolSchema => ({
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
    }),
  };
}

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('MCPServer <-> MCPClient over HTTP', () => {
  let server: MCPServer;
  let client: MCPClient;
  let baseUrl: string;

  const failingExecute = vi.fn(async () => {
    throw new Error('boom');
  });
  const validatedExecute = vi.fn(async (params: { a: number; b: number }) => ({
    sum: params.a + params.b,
  }));
  const transformExecute = vi.fn(async (params: { count: number }) => ({
    doubled: params.count * 2,
    type: typeof params.count,
  }));
  const failingPrompt = vi.fn(async () => {
    throw new Error('prompt exploded');
  });
  const failingResource = vi.fn(async () => {
    throw new Error('resource exploded');
  });

  beforeAll(async () => {
    server = new MCPServer({
      name: 'roundtrip',
      version: '1.0.0',
      transport: 'http',
      port: 0,
      host: '127.0.0.1',
    });

    server.registerTools([
      makeTool('add', z.object({ a: z.number(), b: z.number() }), validatedExecute),
      makeTool('fail', z.object({}), failingExecute),
      makeTool(
        'double',
        z.object({ count: z.string().transform((value) => Number(value)) }),
        transformExecute
      ),
      makeTool('echo_loose', z.looseObject({ id: z.string() }), async (params) => params),
      makeTool('image', z.object({}), async () => [
        { type: 'image', data: PIXEL, mimeType: 'image/png' },
      ]),
      makeTool('typed_rows', z.object({}), async () => [
        { type: 'user', name: 'alice' },
        { type: 'admin', name: 'bob' },
      ]),
    ]);

    server.registerResource({
      uri: 'memo://greeting',
      name: 'greeting',
      mimeType: 'text/plain',
      read: async () => ({ uri: 'memo://greeting', text: 'hello' }),
    });
    server.registerResource({
      uri: 'memo://bundle/{name}',
      name: 'bundle',
      read: async ({ name }) => [
        { uri: `memo://bundle/${name}#a`, text: 'part a' },
        { uri: `memo://bundle/${name}#b`, blob: 'YmluYXJ5', mimeType: 'application/octet-stream' },
      ],
    });
    server.registerResource({
      uri: 'memo://broken',
      name: 'broken',
      read: failingResource,
    });

    server.registerPrompt({
      name: 'with_image',
      get: async () => ({
        messages: [
          { role: 'user', content: { type: 'text', text: 'Describe this' } },
          { role: 'user', content: { type: 'image', data: PIXEL, mimeType: 'image/png' } },
        ],
      }),
    });
    server.registerPrompt({ name: 'broken_prompt', get: failingPrompt });
    server.registerPrompt({
      name: 'greet',
      arguments: [
        { name: 'name', required: true },
        { name: 'tone', required: false },
      ],
      get: async (args) => ({
        messages: [
          { role: 'user', content: { type: 'text', text: `${args.tone ?? 'Hi'} ${args.name}` } },
        ],
      }),
    });

    await server.start();
    baseUrl = `http://127.0.0.1:${server.getPort()}/mcp`;

    client = await MCPClient.connect({
      transport: 'http',
      url: baseUrl,
      retry: { maxRetries: 3, initialDelay: 200 },
    });
  });

  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  it('exposes the bound port', () => {
    expect(server.getPort()).toBeGreaterThan(0);
  });

  it('advertises the full input schema of each tool', async () => {
    const tools = await client.listToolDefinitions();
    const add = tools.find((t) => t.name === 'add');

    expect(add?.inputSchema.properties).toHaveProperty('a');
    expect(add?.inputSchema.properties).toHaveProperty('b');
    expect(add?.inputSchema.required).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('round-trips a structured tool result', async () => {
    const result = await client.callTool('add', { a: 2, b: 3 });
    expect(result).toEqual({ sum: 5 });
  });

  it('rejects invalid arguments with MCPToolError without retrying', async () => {
    validatedExecute.mockClear();
    const started = Date.now();

    await expect(client.callTool('add', { a: 'two', b: 3 })).rejects.toBeInstanceOf(MCPToolError);

    expect(validatedExecute).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('surfaces tool failures as MCPToolError and executes the tool exactly once', async () => {
    failingExecute.mockClear();

    const error = await client.callTool('fail', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MCPToolError);
    expect((error as MCPToolError).message).toContain('boom');
    expect((error as MCPToolError).toolName).toBe('fail');
    expect(failingExecute).toHaveBeenCalledTimes(1);
  });

  it('applies schema transforms exactly once', async () => {
    const result = await client.callTool('double', { count: '21' });
    expect(result).toEqual({ doubled: 42, type: 'number' });
  });

  it('honours object modifiers of the tool schema', async () => {
    const result = await client.callTool('echo_loose', { id: 'x', extra: true });
    expect(result).toEqual({ id: 'x', extra: true });
  });

  it('passes image content through as a media result instead of stringifying it', async () => {
    const result = await client.callTool('image', {});
    expect(result).toEqual({
      type: 'tool-content',
      content: [{ type: 'image', data: PIXEL, mediaType: 'image/png' }],
    });
  });

  it('serializes domain objects with a "type" field as JSON text', async () => {
    const result = await client.callTool('typed_rows', {});
    expect(result).toEqual([
      { type: 'user', name: 'alice' },
      { type: 'admin', name: 'bob' },
    ]);
  });

  it('wraps MCP tools as Cogitator tools that forward the abort signal', async () => {
    const tools = await client.getTools();
    const add = tools.find((t) => t.name === 'add');
    const controller = new AbortController();

    const result = await add?.execute(
      { a: 1, b: 1 },
      { agentId: 'a', runId: 'r', signal: controller.signal }
    );
    expect(result).toEqual({ sum: 2 });
  });

  it('reads resources', async () => {
    const content = await client.readResource('memo://greeting');
    expect(content.text).toBe('hello');
    expect(content.mimeType).toBe('text/plain');
  });

  it('returns every content entry of a multi-part resource', async () => {
    const contents = await client.readResourceContents('memo://bundle/x');

    expect(contents).toEqual([
      { uri: 'memo://bundle/x#a', mimeType: undefined, text: 'part a', blob: undefined },
      {
        uri: 'memo://bundle/x#b',
        mimeType: 'application/octet-stream',
        text: undefined,
        blob: 'YmluYXJ5',
      },
    ]);
    expect((await client.readResource('memo://bundle/x')).text).toBe('part a');
  });

  it('reports resource failures as protocol errors instead of fake content', async () => {
    failingResource.mockClear();
    await expect(client.readResource('memo://broken')).rejects.toThrow('resource exploded');
    expect(failingResource).toHaveBeenCalledTimes(1);
  });

  it('preserves non-text prompt content', async () => {
    const messages = await client.getPrompt('with_image');

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual({ type: 'text', text: 'Describe this' });
    expect(messages[1].content).toEqual({ type: 'image', data: PIXEL, mimeType: 'image/png' });
  });

  it('passes prompt arguments and allows omitting optional ones', async () => {
    const formal = await client.getPrompt('greet', { name: 'Ada', tone: 'Good day' });
    const casual = await client.getPrompt('greet', { name: 'Ada' });

    expect(formal[0].content.text).toBe('Good day Ada');
    expect(casual[0].content.text).toBe('Hi Ada');
  });

  it('lists prompt arguments', async () => {
    const prompts = await client.listPrompts();
    const greet = prompts.find((p) => p.name === 'greet');

    expect(greet?.arguments).toEqual([
      { name: 'name', description: undefined, required: true },
      { name: 'tone', description: undefined, required: false },
    ]);
  });

  it('reports prompt failures as protocol errors without retrying', async () => {
    failingPrompt.mockClear();
    await expect(client.getPrompt('broken_prompt')).rejects.toThrow('prompt exploded');
    expect(failingPrompt).toHaveBeenCalledTimes(1);
  });

  it('accepts requests whose URL carries a query string', async () => {
    const queryClient = await MCPClient.connect({ transport: 'http', url: `${baseUrl}?v=1` });
    try {
      expect(await queryClient.callTool('add', { a: 1, b: 2 })).toEqual({ sum: 3 });
    } finally {
      await queryClient.close();
    }
  });

  it('answers malformed JSON with a JSON-RPC parse error', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{not json',
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('returns 404 for other paths', async () => {
    const response = await fetch(baseUrl.replace('/mcp', '/other'));
    expect(response.status).toBe(404);
  });
});

describe('MCPServer HTTP lifecycle', () => {
  it('rejects start() when the port is already in use', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const server = new MCPServer({
      name: 'busy',
      version: '1.0.0',
      transport: 'http',
      port,
      host: '127.0.0.1',
    });

    try {
      await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
      expect(server.isRunning()).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('stop() does not hang on open keep-alive connections', async () => {
    const server = new MCPServer({
      name: 'keepalive',
      version: '1.0.0',
      transport: 'http',
      port: 0,
      host: '127.0.0.1',
    });
    server.registerTool(makeTool('noop', z.object({}), async () => 'ok'));
    await server.start();

    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${server.getPort()}/mcp`,
    });
    expect(await client.callTool('noop', {})).toBe('ok');

    const stopped = await Promise.race([
      server.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);

    expect(stopped).toBe('stopped');
    expect(server.isRunning()).toBe(false);
    await client.close();
  });
});
