import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { MCPServer, serveMCPTools } from '../server/mcp-server';
import type { Tool, ToolSchema } from '@cogitator-ai/types';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
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
