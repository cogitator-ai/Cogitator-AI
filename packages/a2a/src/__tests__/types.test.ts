import { describe, it, expect } from 'vitest';
import type {
  AgentCard,
  A2ATask,
  A2AMessage,
  Artifact,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types';
import { TERMINAL_STATES, isStreamFinalState, isTerminalState } from '../types';

describe('A2A types', () => {
  it('should construct a valid AgentCard', () => {
    const card: AgentCard = {
      protocolVersion: '0.3.0',
      name: 'test-agent',
      description: 'A test agent',
      url: 'https://example.com/a2a',
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        {
          id: 'search',
          name: 'Web Search',
          description: 'Search the web',
          tags: ['search'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    };
    expect(card.name).toBe('test-agent');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.skills).toHaveLength(1);
  });

  it('should construct a valid A2ATask', () => {
    const task: A2ATask = {
      kind: 'task',
      id: 'task_123',
      contextId: 'ctx_456',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      history: [],
      artifacts: [],
    };
    expect(task.status.state).toBe('completed');
  });

  it('should construct messages with different part kinds', () => {
    const textMsg: A2AMessage = {
      kind: 'message',
      messageId: 'm1',
      role: 'user',
      parts: [{ kind: 'text', text: 'Hello' }],
    };
    const dataMsg: A2AMessage = {
      kind: 'message',
      messageId: 'm2',
      role: 'agent',
      parts: [{ kind: 'data', data: { key: 'value' } }],
    };
    const fileMsg: A2AMessage = {
      kind: 'message',
      messageId: 'm3',
      role: 'agent',
      parts: [
        {
          kind: 'file',
          file: { uri: 'https://example.com/file.pdf', mimeType: 'application/pdf' },
        },
        { kind: 'file', file: { bytes: 'aGVsbG8=', name: 'hello.txt' } },
      ],
    };
    expect(textMsg.parts[0].kind).toBe('text');
    expect(dataMsg.parts[0].kind).toBe('data');
    expect(fileMsg.parts[0].kind).toBe('file');
  });

  it('should identify terminal states correctly', () => {
    expect(isTerminalState('completed')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('canceled')).toBe(true);
    expect(isTerminalState('rejected')).toBe(true);
    expect(isTerminalState('submitted')).toBe(false);
    expect(isTerminalState('working')).toBe(false);
    expect(isTerminalState('input-required')).toBe(false);
    expect(isTerminalState('auth-required')).toBe(false);
  });

  it('should end a stream at terminal states and where the task waits on the client', () => {
    expect(isStreamFinalState('input-required')).toBe(true);
    expect(isStreamFinalState('auth-required')).toBe(true);
    expect(isStreamFinalState('completed')).toBe(true);
    expect(isStreamFinalState('working')).toBe(false);
    expect(isStreamFinalState('submitted')).toBe(false);
  });

  it('should have correct terminal states', () => {
    expect(TERMINAL_STATES).toEqual(['completed', 'failed', 'canceled', 'rejected']);
  });

  it('should construct stream events', () => {
    const statusEvent: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: 'task_1',
      contextId: 'ctx_1',
      status: { state: 'working', timestamp: new Date().toISOString() },
      final: false,
    };
    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: 'task_1',
      contextId: 'ctx_1',
      artifact: { artifactId: 'art_1', parts: [{ kind: 'text', text: 'result' }] },
      append: true,
      lastChunk: false,
    };
    expect(statusEvent.kind).toBe('status-update');
    expect(artifactEvent.kind).toBe('artifact-update');
  });

  it('should construct artifacts with multiple parts', () => {
    const artifact: Artifact = {
      artifactId: 'art_1',
      name: 'report',
      parts: [
        { kind: 'text', text: 'Summary' },
        { kind: 'data', data: { total: 42 } },
      ],
    };
    expect(artifact.parts).toHaveLength(2);
  });

  it('should support security schemes', () => {
    const card: AgentCard = {
      protocolVersion: '0.3.0',
      name: 'secure-agent',
      description: 'A secured agent',
      url: 'https://example.com/a2a',
      version: '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      skills: [],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      security: [{ bearer: [] }],
    };
    expect(card.securitySchemes).toBeDefined();
    expect(card.security).toHaveLength(1);
  });
});
