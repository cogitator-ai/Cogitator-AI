import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { A2AClient } from '../client';
import type { A2ATask, A2AMessage, AgentCard, A2AStreamEvent } from '../types';
import { A2AError } from '../errors';

let mockServer: http.Server;
let baseUrl: string;

let mockAgentCard: AgentCard;
let mockSendResult: A2ATask;
let mockError: { code: number; message: string } | null = null;

function createMockTask(
  id: string,
  state: string = 'completed',
  output: string = 'Test output'
): A2ATask {
  return {
    id,
    contextId: 'ctx_1',
    status: { state: state as A2ATask['status']['state'], timestamp: new Date().toISOString() },
    history: [
      { role: 'user', parts: [{ type: 'text', text: 'test input' }] },
      { role: 'agent', parts: [{ type: 'text', text: output }] },
    ],
    artifacts: [{ id: 'art_1', parts: [{ type: 'text', text: output }], mimeType: 'text/plain' }],
  };
}

beforeAll(async () => {
  mockAgentCard = {
    name: 'test-agent',
    url: 'http://localhost/a2a',
    version: '0.3',
    description: 'A test agent',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      {
        id: 'search',
        name: 'search',
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };
  mockSendResult = createMockTask('task_1');

  mockServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/agent.json' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockAgentCard));
      return;
    }

    if (req.url === '/a2a' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body);

        if (request.method === 'message/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const workingEvent: A2AStreamEvent = {
            type: 'status-update',
            taskId: 'task_stream',
            status: { state: 'working', timestamp: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          };
          res.write(`data: ${JSON.stringify(workingEvent)}\n\n`);

          const completedEvent: A2AStreamEvent = {
            type: 'status-update',
            taskId: 'task_stream',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            timestamp: new Date().toISOString(),
          };
          res.write(`data: ${JSON.stringify(completedEvent)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (mockError) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: mockError, id: request.id }));
          return;
        }

        let result: unknown;

        if (request.method === 'message/send') {
          result = mockSendResult;
        } else if (request.method === 'tasks/get') {
          result = mockSendResult;
        } else if (request.method === 'tasks/cancel') {
          result = {
            ...mockSendResult,
            status: { state: 'canceled', timestamp: new Date().toISOString() },
          };
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32601, message: 'Method not found' },
              id: request.id,
            })
          );
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result, id: request.id }));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, () => {
      const addr = mockServer.address() as { port: number };
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  mockServer.close();
});

beforeEach(() => {
  mockError = null;
  mockSendResult = createMockTask('task_1');
});

describe('A2AClient', () => {
  describe('agentCard', () => {
    it('should fetch agent card', async () => {
      const client = new A2AClient(baseUrl);
      const card = await client.agentCard();
      expect(card.name).toBe('test-agent');
      expect(card.version).toBe('0.3');
    });

    it('should cache agent card', async () => {
      const client = new A2AClient(baseUrl);
      const card1 = await client.agentCard();
      const card2 = await client.agentCard();
      expect(card1).toBe(card2);
    });
  });

  describe('sendMessage', () => {
    it('should send message and return task', async () => {
      const client = new A2AClient(baseUrl);
      const msg: A2AMessage = { role: 'user', parts: [{ type: 'text', text: 'Hello' }] };
      const task = await client.sendMessage(msg);
      expect(task.id).toBe('task_1');
      expect(task.status.state).toBe('completed');
    });

    it('should throw A2AError on JSON-RPC error', async () => {
      mockError = { code: -32001, message: 'Task not found' };
      const client = new A2AClient(baseUrl);
      await expect(
        client.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'fail' }] })
      ).rejects.toThrow(A2AError);
    });
  });

  describe('sendMessageStream', () => {
    it('should yield streaming events', async () => {
      const client = new A2AClient(baseUrl);
      const events: A2AStreamEvent[] = [];
      for await (const event of client.sendMessageStream({
        role: 'user',
        parts: [{ type: 'text', text: 'Stream' }],
      })) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThanOrEqual(1);
      const statusEvents = events.filter((e) => e.type === 'status-update');
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should terminate on completed state', async () => {
      const client = new A2AClient(baseUrl);
      const events: A2AStreamEvent[] = [];
      for await (const event of client.sendMessageStream({
        role: 'user',
        parts: [{ type: 'text', text: 'Done' }],
      })) {
        events.push(event);
      }
      const lastStatus = [...events].reverse().find((e) => e.type === 'status-update');
      expect(lastStatus).toBeDefined();
      if (lastStatus?.type === 'status-update') {
        expect(lastStatus.status.state).toBe('completed');
      }
    });
  });

  describe('getTask', () => {
    it('should get task by id', async () => {
      const client = new A2AClient(baseUrl);
      const task = await client.getTask('task_1');
      expect(task.id).toBe('task_1');
    });
  });

  describe('cancelTask', () => {
    it('should cancel task', async () => {
      const client = new A2AClient(baseUrl);
      const task = await client.cancelTask('task_1');
      expect(task.status.state).toBe('canceled');
    });
  });

  describe('asTool', () => {
    it('should return a valid Cogitator Tool', () => {
      const client = new A2AClient(baseUrl);
      const tool = client.asTool({ name: 'remote_agent', description: 'Test agent' });
      expect(tool.name).toBe('remote_agent');
      expect(tool.description).toBe('Test agent');
      expect(tool.toJSON()).toHaveProperty('parameters');
    });

    it('should execute tool and return success', async () => {
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      const result = await tool.execute(
        { task: 'Do something' },
        { agentId: 'test', runId: 'run_1', signal: new AbortController().signal }
      );
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('output');
      expect(result.output.length).toBeGreaterThan(0);
    });

    it('should return failure on error', async () => {
      mockError = { code: -32001, message: 'Task not found' };
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      const result = await tool.execute(
        { task: 'Fail' },
        { agentId: 'test', runId: 'run_1', signal: new AbortController().signal }
      );
      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
    });

    it('should return failure for failed task state', async () => {
      mockSendResult = createMockTask('task_fail', 'failed', '');
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      const result = await tool.execute(
        { task: 'Fail task' },
        { agentId: 'test', runId: 'run_1', signal: new AbortController().signal }
      );
      expect(result).toHaveProperty('success', false);
    });

    it('should use default name and description', () => {
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      expect(tool.name).toBe('a2a_remote_agent');
      expect(tool.description).toBe('Remote A2A agent');
    });

    it('should include sideEffects as external', () => {
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      expect(tool.sideEffects).toEqual(['external']);
    });
  });

  describe('asToolFromCard', () => {
    it('should create tool with card name and description', async () => {
      const client = new A2AClient(baseUrl);
      const card = await client.agentCard();
      const tool = client.asToolFromCard(card);
      expect(tool.name).toBe('test-agent');
      expect(tool.description).toContain('test agent');
    });
  });

  describe('extractOutputFromTask edge cases', () => {
    it('should handle task with no artifacts and no history', async () => {
      mockSendResult = {
        id: 'task_empty',
        contextId: 'ctx_1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        history: [],
        artifacts: [],
      };
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      const result = await tool.execute(
        { task: 'Empty result' },
        { agentId: 'test', runId: 'run_1', signal: new AbortController().signal }
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('should handle task with undefined artifacts', async () => {
      mockSendResult = {
        id: 'task_noart',
        contextId: 'ctx_1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        history: [{ role: 'agent', parts: [{ type: 'text', text: 'from history' }] }],
      } as A2ATask;
      const client = new A2AClient(baseUrl);
      const tool = client.asTool();
      const result = await tool.execute(
        { task: 'No artifacts' },
        { agentId: 'test', runId: 'run_1', signal: new AbortController().signal }
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('from history');
    });
  });

  describe('agentCard error handling', () => {
    it('should throw on empty array response', async () => {
      const emptyServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
      const emptyUrl = await new Promise<string>((resolve) => {
        emptyServer.listen(0, () => {
          const addr = emptyServer.address() as { port: number };
          resolve(`http://localhost:${addr.port}`);
        });
      });
      try {
        const client = new A2AClient(emptyUrl);
        await expect(client.agentCard()).rejects.toThrow('empty array');
      } finally {
        emptyServer.close();
      }
    });
  });

  describe('custom config', () => {
    it('should use custom headers', async () => {
      const client = new A2AClient(baseUrl, {
        headers: { Authorization: 'Bearer token123' },
      });
      const card = await client.agentCard();
      expect(card.name).toBe('test-agent');
    });

    it('should use custom paths', async () => {
      const client = new A2AClient(baseUrl, { agentCardPath: '/custom/card' });
      await expect(client.agentCard()).rejects.toThrow();
    });

    it('should strip trailing slash from base URL', async () => {
      const client = new A2AClient(`${baseUrl}/`);
      const card = await client.agentCard();
      expect(card.name).toBe('test-agent');
    });
  });
});
