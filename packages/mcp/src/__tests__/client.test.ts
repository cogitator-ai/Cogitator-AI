import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClient, connectMCPServer } from '../client/mcp-client';

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class Client {
    connect = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    getServerCapabilities = vi.fn().mockReturnValue({
      tools: true,
      resources: true,
      prompts: true,
    });
    listTools = vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      ],
    });
    callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"result": "success"}' }],
    });
    listResources = vi.fn().mockResolvedValue({
      resources: [
        {
          uri: 'file://test.txt',
          name: 'test.txt',
          description: 'Test file',
          mimeType: 'text/plain',
        },
      ],
    });
    readResource = vi.fn().mockResolvedValue({
      contents: [{ uri: 'file://test.txt', text: 'Hello World' }],
    });
    listPrompts = vi.fn().mockResolvedValue({
      prompts: [
        {
          name: 'test_prompt',
          description: 'A test prompt',
          arguments: [{ name: 'arg1', description: 'First argument', required: true }],
        },
      ],
    });
    getPrompt = vi.fn().mockResolvedValue({
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
    });
  }
  return { Client };
});

vi.mock('../client/transports', () => ({
  createStdioTransport: vi.fn().mockReturnValue({}),
  createHttpTransport: vi.fn().mockReturnValue({}),
}));

describe('MCPClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('connect', () => {
    it('connects with stdio transport', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test-command',
        args: ['--arg1'],
      });

      expect(client.isConnected()).toBe(true);
      await client.close();
    });

    it('connects with http transport', async () => {
      const client = await MCPClient.connect({
        transport: 'http',
        url: 'http://localhost:3000',
      });

      expect(client.isConnected()).toBe(true);
      await client.close();
    });

    it('throws error for stdio without command', async () => {
      await expect(
        MCPClient.connect({
          transport: 'stdio',
        })
      ).rejects.toThrow('Command is required');
    });

    it('throws error for http without url', async () => {
      await expect(
        MCPClient.connect({
          transport: 'http',
        })
      ).rejects.toThrow('URL is required');
    });

    it('connects with sse transport (alias for http)', async () => {
      const client = await MCPClient.connect({
        transport: 'sse',
        url: 'http://localhost:3000',
      });

      expect(client.isConnected()).toBe(true);
      await client.close();
    });

    it('throws for unknown transport type', async () => {
      await expect(
        MCPClient.connect({
          transport: 'unknown' as 'stdio',
        })
      ).rejects.toThrow('Unknown transport type');
    });
  });

  describe('capabilities', () => {
    it('returns server capabilities', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const caps = client.getCapabilities();

      expect(caps.tools).toBe(true);
      expect(caps.resources).toBe(true);
      expect(caps.prompts).toBe(true);

      await client.close();
    });
  });

  describe('tools', () => {
    it('lists tool definitions', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const tools = await client.listToolDefinitions();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test_tool');
      expect(tools[0].description).toBe('A test tool');

      await client.close();
    });

    it('gets tools as Cogitator tools', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const tools = await client.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test_tool');
      expect(tools[0].parameters).toBeDefined();

      await client.close();
    });

    it('calls a tool', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const result = await client.callTool('test_tool', { input: 'test' });

      expect(result).toEqual({ result: 'success' });

      await client.close();
    });
  });

  describe('resources', () => {
    it('lists resources', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const resources = await client.listResources();

      expect(resources).toHaveLength(1);
      expect(resources[0].uri).toBe('file://test.txt');

      await client.close();
    });

    it('reads a resource', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const content = await client.readResource('file://test.txt');

      expect(content.text).toBe('Hello World');

      await client.close();
    });
  });

  describe('prompts', () => {
    it('lists prompts', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const prompts = await client.listPrompts();

      expect(prompts).toHaveLength(1);
      expect(prompts[0].name).toBe('test_prompt');

      await client.close();
    });

    it('gets a prompt', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      const messages = await client.getPrompt('test_prompt', { arg1: 'value' });

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');

      await client.close();
    });
  });

  describe('close', () => {
    it('close is idempotent', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      await client.close();
      await client.close();

      expect(client.isConnected()).toBe(false);
    });
  });

  describe('reconnecting', () => {
    it('reports not reconnecting initially', async () => {
      const client = await MCPClient.connect({
        transport: 'stdio',
        command: 'test',
      });

      expect(client.isReconnecting()).toBe(false);
      await client.close();
    });
  });
});

describe('connectMCPServer', () => {
  it('connects and returns tools and cleanup', async () => {
    const { client, tools, cleanup } = await connectMCPServer({
      transport: 'stdio',
      command: 'test',
    });

    expect(client.isConnected()).toBe(true);
    expect(tools).toHaveLength(1);

    await cleanup();
    expect(client.isConnected()).toBe(false);
  });
});
