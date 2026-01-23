import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { MCPServer, serveMCPTools } from '../server/mcp-server';
import type { Tool, ToolSchema } from '@cogitator-ai/types';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(),
    registerResource: vi.fn(),
    registerPrompt: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  ResourceTemplate: vi.fn().mockImplementation((uri: string) => ({
    uriTemplate: { template: uri },
  })),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

const mockTool: Tool = {
  name: 'test_tool',
  description: 'A test tool',
  parameters: z.object({
    input: z.string(),
  }),
  execute: vi.fn().mockResolvedValue({ result: 'success' }),
  toJSON: (): ToolSchema => ({
    name: 'test_tool',
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
  }),
};

const mockToolNoParams: Tool = {
  name: 'simple_tool',
  description: 'A simple tool without Zod params',
  execute: vi.fn().mockResolvedValue('simple result'),
  toJSON: (): ToolSchema => ({
    name: 'simple_tool',
    description: 'A simple tool',
    parameters: {
      type: 'object',
      properties: { value: { type: 'number' } },
    },
  }),
};

describe('MCPServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates server with config', () => {
      const server = new MCPServer({
        name: 'test-server',
        version: '1.0.0',
        transport: 'stdio',
      });

      expect(server.isRunning()).toBe(false);
    });
  });

  describe('registerTool', () => {
    it('registers a tool', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerTool(mockTool);

      expect(server.getRegisteredTools()).toContain('test_tool');
    });

    it('registers multiple tools', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerTools([mockTool, mockToolNoParams]);

      expect(server.getRegisteredTools()).toHaveLength(2);
      expect(server.getRegisteredTools()).toContain('test_tool');
      expect(server.getRegisteredTools()).toContain('simple_tool');
    });

    it('throws when registering after start', async () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      await server.start();

      expect(() => server.registerTool(mockTool)).toThrow(
        'Cannot register tools after server has started'
      );

      await server.stop();
    });
  });

  describe('unregisterTool', () => {
    it('removes a registered tool', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerTool(mockTool);
      expect(server.getRegisteredTools()).toContain('test_tool');

      const removed = server.unregisterTool('test_tool');

      expect(removed).toBe(true);
      expect(server.getRegisteredTools()).not.toContain('test_tool');
    });

    it('returns false for non-existent tool', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      const removed = server.unregisterTool('nonexistent');

      expect(removed).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('starts with stdio transport', async () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      await server.start();

      expect(server.isRunning()).toBe(true);

      await server.stop();

      expect(server.isRunning()).toBe(false);
    });

    it('throws when starting twice', async () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      await server.start();

      await expect(server.start()).rejects.toThrow('Server already started');

      await server.stop();
    });

    it('stop is idempotent', async () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      await server.stop();
      await server.stop();

      expect(server.isRunning()).toBe(false);
    });
  });

  describe('logging', () => {
    it('logs when enabled', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
        logging: true,
      });

      server.registerTool(mockTool);
      await server.start();

      expect(consoleSpy).toHaveBeenCalled();

      await server.stop();
      consoleSpy.mockRestore();
    });
  });
});

describe('serveMCPTools', () => {
  it('creates and starts server with tools', async () => {
    const server = await serveMCPTools([mockTool], {
      name: 'test',
      version: '1.0.0',
      transport: 'stdio',
    });

    expect(server.isRunning()).toBe(true);
    expect(server.getRegisteredTools()).toContain('test_tool');

    await server.stop();
  });
});

describe('MCPServer Resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerResource', () => {
    it('registers a static resource', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerResource({
        uri: 'memory://threads',
        name: 'Threads',
        description: 'List of threads',
        mimeType: 'application/json',
        read: async () => ({ text: '[]' }),
      });

      expect(server.getRegisteredResources()).toContain('memory://threads');
    });

    it('registers a dynamic resource with template', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerResource({
        uri: 'memory://thread/{id}',
        name: 'Thread',
        read: async ({ id }) => ({ text: JSON.stringify({ id }) }),
      });

      expect(server.getRegisteredResources()).toContain('memory://thread/{id}');
    });

    it('registers multiple resources', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerResources([
        {
          uri: 'memory://threads',
          name: 'Threads',
          read: async () => ({ text: '[]' }),
        },
        {
          uri: 'memory://thread/{id}',
          name: 'Thread',
          read: async () => ({ text: '{}' }),
        },
      ]);

      expect(server.getRegisteredResources()).toHaveLength(2);
    });

    it('throws when registering after start', async () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      await server.start();

      expect(() =>
        server.registerResource({
          uri: 'memory://test',
          name: 'Test',
          read: async () => ({ text: 'test' }),
        })
      ).toThrow('Cannot register resources after server has started');

      await server.stop();
    });
  });

  describe('unregisterResource', () => {
    it('removes a registered resource', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerResource({
        uri: 'memory://test',
        name: 'Test',
        read: async () => ({ text: 'test' }),
      });

      const removed = server.unregisterResource('memory://test');

      expect(removed).toBe(true);
      expect(server.getRegisteredResources()).not.toContain('memory://test');
    });

    it('returns false for non-existent resource', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      expect(server.unregisterResource('memory://nonexistent')).toBe(false);
    });
  });
});

describe('MCPServer Prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerPrompt', () => {
    it('registers a simple prompt', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerPrompt({
        name: 'summarize',
        description: 'Summarize content',
        get: async () => ({
          messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this' } }],
        }),
      });

      expect(server.getRegisteredPrompts()).toContain('summarize');
    });

    it('registers a prompt with arguments', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerPrompt({
        name: 'review-code',
        title: 'Code Review',
        description: 'Review code for issues',
        arguments: [
          { name: 'code', description: 'Code to review', required: true },
          { name: 'style', description: 'Review style', required: false },
        ],
        get: async ({ code, style }) => ({
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: `Review (${style || 'default'}): ${code}` },
            },
          ],
        }),
      });

      expect(server.getRegisteredPrompts()).toContain('review-code');
    });

    it('registers multiple prompts', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerPrompts([
        {
          name: 'summarize',
          get: async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Summarize' } }],
          }),
        },
        {
          name: 'translate',
          get: async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Translate' } }],
          }),
        },
      ]);

      expect(server.getRegisteredPrompts()).toHaveLength(2);
      expect(server.getRegisteredPrompts()).toContain('summarize');
      expect(server.getRegisteredPrompts()).toContain('translate');
    });

    it('throws when registering after start', async () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      await server.start();

      expect(() =>
        server.registerPrompt({
          name: 'test',
          get: async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Test' } }],
          }),
        })
      ).toThrow('Cannot register prompts after server has started');

      await server.stop();
    });
  });

  describe('unregisterPrompt', () => {
    it('removes a registered prompt', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      server.registerPrompt({
        name: 'test',
        get: async () => ({
          messages: [{ role: 'user', content: { type: 'text', text: 'Test' } }],
        }),
      });

      const removed = server.unregisterPrompt('test');

      expect(removed).toBe(true);
      expect(server.getRegisteredPrompts()).not.toContain('test');
    });

    it('returns false for non-existent prompt', () => {
      const server = new MCPServer({
        name: 'test',
        version: '1.0.0',
        transport: 'stdio',
      });

      expect(server.unregisterPrompt('nonexistent')).toBe(false);
    });
  });
});
