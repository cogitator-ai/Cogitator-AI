import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { A2AClient } from '../client';
import type { A2ATask, AgentCard, A2AStreamEvent, SendMessageResult, TaskState } from '../types';
import { A2AError } from '../errors';

let mockServer: http.Server;
let baseUrl: string;

let mockAgentCard: AgentCard;
let mockSendResult: SendMessageResult;
let mockError: { code: number; message: string } | null = null;
let lastRequest: { method: string; params: Record<string, unknown> } | null = null;
let serveLegacyCardOnly = false;

function createMockTask(
  id: string,
  state: TaskState = 'completed',
  output = 'Test output'
): A2ATask {
  return {
    kind: 'task',
    id,
    contextId: 'ctx_1',
    status: { state, timestamp: new Date().toISOString() },
    history: [
      {
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        parts: [{ kind: 'text', text: 'test input' }],
      },
      { kind: 'message', messageId: 'm2', role: 'agent', parts: [{ kind: 'text', text: output }] },
    ],
    artifacts: [{ artifactId: 'art_1', parts: [{ kind: 'text', text: output }] }],
  };
}

function sse(id: unknown, result: A2AStreamEvent): string {
  return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

beforeAll(async () => {
  mockAgentCard = {
    protocolVersion: '0.3.0',
    name: 'test-agent',
    url: '/a2a',
    preferredTransport: 'JSONRPC',
    version: '1.0.0',
    description: 'A test agent',
    capabilities: { streaming: true, pushNotifications: false },
    skills: [{ id: 'search', name: 'search', description: 'Search', tags: ['search'] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };

  mockServer = http.createServer((req, res) => {
    const cardPath = serveLegacyCardOnly
      ? '/.well-known/agent.json'
      : '/.well-known/agent-card.json';
    if (req.url === cardPath && req.method === 'GET') {
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
        lastRequest = { method: request.method, params: request.params };

        if (request.method === 'message/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const base = { taskId: 'task_stream', contextId: 'ctx_1' };
          res.write(': heartbeat\n\n');
          res.write(
            sse(request.id, {
              kind: 'status-update',
              ...base,
              status: { state: 'working' },
              final: false,
            })
          );
          res.write(
            sse(request.id, {
              kind: 'artifact-update',
              ...base,
              artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'hi' }] },
              lastChunk: true,
            })
          );
          res.write(
            sse(request.id, {
              kind: 'status-update',
              ...base,
              status: { state: 'completed' },
              final: true,
            })
          );
          res.write(
            sse(request.id, {
              kind: 'status-update',
              ...base,
              status: { state: 'failed' },
              final: true,
            })
          );
          res.end();
          return;
        }

        if (mockError) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: mockError, id: request.id }));
          return;
        }

        let result: unknown;
        if (request.method === 'message/send' || request.method === 'tasks/get') {
          result = mockSendResult;
        } else if (request.method === 'tasks/cancel') {
          result = {
            ...(mockSendResult as A2ATask),
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
  lastRequest = null;
  serveLegacyCardOnly = false;
  mockSendResult = createMockTask('task_1');
});

const toolContext = () => ({
  agentId: 'test',
  runId: 'run_1',
  signal: new AbortController().signal,
});

describe('A2AClient', () => {
  describe('agentCard', () => {
    it('should fetch the agent card from the well-known agent-card.json', async () => {
      const client = new A2AClient(baseUrl);
      const card = await client.agentCard();
      expect(card.name).toBe('test-agent');
      expect(card.protocolVersion).toBe('0.3.0');
    });

    it('should fall back to the pre-v0.3 agent.json', async () => {
      serveLegacyCardOnly = true;
      const card = await new A2AClient(baseUrl).agentCard();
      expect(card.name).toBe('test-agent');
    });

    it('should cache agent card', async () => {
      const client = new A2AClient(baseUrl);
      const card1 = await client.agentCard();
      const card2 = await client.agentCard();
      expect(card1).toBe(card2);
    });
  });

  describe('sendMessage', () => {
    it('should send a v0.3 message to the endpoint the card names and return the task', async () => {
      const client = new A2AClient(baseUrl);
      const result = await client.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'Hello' }],
      });
      expect(result.kind).toBe('task');
      expect(result.kind === 'task' && result.status.state).toBe('completed');

      const message = lastRequest?.params.message as Record<string, unknown>;
      expect(lastRequest?.method).toBe('message/send');
      expect(message.kind).toBe('message');
      expect(message.messageId).toEqual(expect.any(String));
      expect(message.parts).toEqual([{ kind: 'text', text: 'Hello' }]);
    });

    it('should keep a messageId the caller sets', async () => {
      await new A2AClient(baseUrl).sendMessage({
        role: 'user',
        messageId: 'my-id',
        parts: [{ kind: 'text', text: 'Hello' }],
      });
      expect((lastRequest?.params.message as { messageId: string }).messageId).toBe('my-id');
    });

    it('should return a direct reply message', async () => {
      mockSendResult = {
        kind: 'message',
        messageId: 'reply',
        role: 'agent',
        parts: [{ kind: 'text', text: 'direct' }],
      };
      const result = await new A2AClient(baseUrl).sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'Hello' }],
      });
      expect(result.kind).toBe('message');
    });

    it('should throw A2AError on JSON-RPC error', async () => {
      mockError = { code: -32001, message: 'Task not found' };
      const client = new A2AClient(baseUrl);
      await expect(
        client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'fail' }] })
      ).rejects.toThrow(A2AError);
    });
  });

  describe('sendMessageStream', () => {
    it('should unwrap JSON-RPC responses and stop at the final status update', async () => {
      const client = new A2AClient(baseUrl);
      const events: A2AStreamEvent[] = [];
      for await (const event of client.sendMessageStream({
        role: 'user',
        parts: [{ kind: 'text', text: 'Stream' }],
      })) {
        events.push(event);
      }
      expect(events.map((e) => e.kind)).toEqual([
        'status-update',
        'artifact-update',
        'status-update',
      ]);
      const last = events.at(-1);
      expect(last?.kind === 'status-update' && last.status.state).toBe('completed');
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
      const result = await new A2AClient(baseUrl)
        .asTool()
        .execute({ task: 'Do something' }, toolContext());
      expect(result).toMatchObject({ success: true, output: 'Test output' });
    });

    it('should prefer the status message for the output', async () => {
      const task = createMockTask('task_1');
      task.status.message = {
        kind: 'message',
        messageId: 's',
        role: 'agent',
        parts: [{ kind: 'text', text: 'final answer' }],
      };
      mockSendResult = task;
      const result = await new A2AClient(baseUrl).asTool().execute({ task: 'x' }, toolContext());
      expect(result.output).toBe('final answer');
    });

    it('should return the text of a direct reply message', async () => {
      mockSendResult = {
        kind: 'message',
        messageId: 'reply',
        role: 'agent',
        parts: [{ kind: 'text', text: 'direct' }],
      };
      const result = await new A2AClient(baseUrl).asTool().execute({ task: 'x' }, toolContext());
      expect(result).toEqual({ output: 'direct', success: true });
    });

    it('should return failure on error', async () => {
      mockError = { code: -32001, message: 'Task not found' };
      const result = await new A2AClient(baseUrl).asTool().execute({ task: 'Fail' }, toolContext());
      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
    });

    it('should return failure for failed task state', async () => {
      mockSendResult = createMockTask('task_fail', 'failed', '');
      const result = await new A2AClient(baseUrl)
        .asTool()
        .execute({ task: 'Fail task' }, toolContext());
      expect(result).toHaveProperty('success', false);
    });

    it('reports the calls a remote task waits on for approval', async () => {
      const waiting = createMockTask('task_wait', 'input-required', 'Let me refund that.');
      waiting.history![1].parts.push({
        kind: 'data',
        data: {
          kind: 'tool-approval-request',
          approvals: [
            { toolCallId: 'c1', toolName: 'refund', arguments: { order: 'A-1' }, description: 'R' },
          ],
        },
      });
      mockSendResult = waiting;
      const result = await new A2AClient(baseUrl)
        .asTool()
        .execute({ task: 'Refund A-1' }, toolContext());

      expect(result.success).toBe(false);
      expect(result.taskId).toBe('task_wait');
      expect(result.error).toBe(
        'Remote agent waits for approval of refund before it continues this task'
      );
      expect(result.pendingApprovals?.map((p) => p.toolCallId)).toEqual(['c1']);
    });

    it('should use default name and description', () => {
      const tool = new A2AClient(baseUrl).asTool();
      expect(tool.name).toBe('a2a_remote_agent');
      expect(tool.description).toBe('Remote A2A agent');
    });

    it('should include sideEffects as external', () => {
      expect(new A2AClient(baseUrl).asTool().sideEffects).toEqual(['external']);
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

  describe('task output edge cases', () => {
    it('should handle task with no artifacts and no history', async () => {
      mockSendResult = {
        kind: 'task',
        id: 'task_empty',
        contextId: 'ctx_1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        history: [],
        artifacts: [],
      };
      const result = await new A2AClient(baseUrl)
        .asTool()
        .execute({ task: 'Empty result' }, toolContext());
      expect(result.success).toBe(true);
      expect(result.output).toBe('');
    });

    it('should handle task with undefined artifacts', async () => {
      mockSendResult = {
        kind: 'task',
        id: 'task_noart',
        contextId: 'ctx_1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        history: [
          {
            kind: 'message',
            messageId: 'm',
            role: 'agent',
            parts: [{ kind: 'text', text: 'from history' }],
          },
        ],
      };
      const result = await new A2AClient(baseUrl)
        .asTool()
        .execute({ task: 'No artifacts' }, toolContext());
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

    it('should use a custom card path without falling back', async () => {
      const client = new A2AClient(baseUrl, { agentCardPath: '/custom/card' });
      await expect(client.agentCard()).rejects.toThrow();
    });

    it('should send to rpcPath without reading the card', async () => {
      const client = new A2AClient(baseUrl, {
        rpcPath: '/a2a',
        agentCardPath: '/missing',
      });
      const task = await client.getTask('task_1');
      expect(task.id).toBe('task_1');
    });

    it('should strip trailing slash from base URL', async () => {
      const client = new A2AClient(`${baseUrl}/`);
      const card = await client.agentCard();
      expect(card.name).toBe('test-agent');
    });
  });
});
