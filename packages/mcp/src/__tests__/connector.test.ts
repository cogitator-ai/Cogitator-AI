import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { experimental_mcpConnector, mcpClientConfigOf } from '../client/connector';

const SERVER = join(__dirname, 'fixtures', 'ping-server.mjs');

describe('experimental_mcpConnector', () => {
  it('reads .mcp.json servers as client configs', () => {
    expect(
      mcpClientConfigOf('a', { command: 'node', args: ['s.js'], env: { A: '1' } })
    ).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['s.js'],
      env: { A: '1' },
    });
    expect(
      mcpClientConfigOf('b', { type: 'sse', url: 'https://mcp.example.com/sse' })
    ).toMatchObject({ transport: 'sse', url: 'https://mcp.example.com/sse' });
    expect(
      mcpClientConfigOf('c', { url: 'https://mcp.example.com/', headers: { A: 'b' } })
    ).toMatchObject({ transport: 'http', headers: { A: 'b' } });
    expect(() => mcpClientConfigOf('d', { args: [] })).toThrow(/needs a command or a url/);
  });

  it('connects a stdio server and names its tools mcp__<server>__<tool>', async () => {
    const connect = experimental_mcpConnector();
    const connection = await connect(
      [
        {
          name: 'plugin:demo:srv',
          config: { command: process.execPath, args: [SERVER], env: { DEMO_VALUE: 'from-env' } },
        },
      ],
      { agent: 'demo@inline', signal: new AbortController().signal }
    );
    try {
      const names = connection.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(['mcp__plugin_demo_srv__env', 'mcp__plugin_demo_srv__ping']);
      const ping = connection.tools.find((tool) => tool.name === 'mcp__plugin_demo_srv__ping');
      expect(ping?.mcp).toEqual({ server: 'plugin:demo:srv', tool: 'ping' });
      const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
      expect(await ping?.execute({ word: 'back' }, context)).toBe('pong back');
      const env = connection.tools.find((tool) => tool.name === 'mcp__plugin_demo_srv__env');
      expect(await env?.execute({ name: 'DEMO_VALUE' }, context)).toBe('from-env');
    } finally {
      await connection.close();
    }
  });
});
