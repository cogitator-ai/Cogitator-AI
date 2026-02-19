import { describe, it, expect } from 'vitest';
import type {
  AgentCard,
  A2ATask,
  A2AMessage,
  TextPart,
  FilePart,
  DataPart,
  TaskState,
  TaskStatus,
  A2ACapabilities,
  AgentSkill,
  AgentProvider,
  A2AErrorDetail,
  Artifact,
  Part,
  SendMessageConfiguration,
  TaskFilter,
  TaskStore,
  A2AStreamEvent,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  A2AServerConfig,
  A2AClientConfig,
  SecurityScheme,
  A2AAuthConfig,
} from '../types';
import { TERMINAL_STATES, isTerminalState } from '../types';

describe('A2A types', () => {
  it('should construct a valid AgentCard', () => {
    const card: AgentCard = {
      name: 'test-agent',
      url: 'https://example.com/a2a',
      version: '0.3',
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        {
          id: 'search',
          name: 'Web Search',
          description: 'Search the web',
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
      id: 'task_123',
      contextId: 'ctx_456',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      history: [],
      artifacts: [],
    };
    expect(task.status.state).toBe('completed');
  });

  it('should construct messages with different part types', () => {
    const textMsg: A2AMessage = {
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    };
    const dataMsg: A2AMessage = {
      role: 'agent',
      parts: [{ type: 'data', mimeType: 'application/json', data: { key: 'value' } }],
    };
    const fileMsg: A2AMessage = {
      role: 'agent',
      parts: [{ type: 'file', uri: 'https://example.com/file.pdf', mimeType: 'application/pdf' }],
    };
    expect(textMsg.parts[0].type).toBe('text');
    expect(dataMsg.parts[0].type).toBe('data');
    expect(fileMsg.parts[0].type).toBe('file');
  });

  it('should identify terminal states correctly', () => {
    expect(isTerminalState('completed')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('canceled')).toBe(true);
    expect(isTerminalState('rejected')).toBe(true);
    expect(isTerminalState('working')).toBe(false);
    expect(isTerminalState('input-required')).toBe(false);
  });

  it('should have correct terminal states', () => {
    expect(TERMINAL_STATES).toEqual(['completed', 'failed', 'canceled', 'rejected']);
  });

  it('should construct stream events', () => {
    const statusEvent: TaskStatusUpdateEvent = {
      type: 'status-update',
      taskId: 'task_1',
      status: { state: 'working', timestamp: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    };
    const artifactEvent: TaskArtifactUpdateEvent = {
      type: 'artifact-update',
      taskId: 'task_1',
      artifact: { id: 'art_1', parts: [{ type: 'text', text: 'result' }] },
      timestamp: new Date().toISOString(),
    };
    expect(statusEvent.type).toBe('status-update');
    expect(artifactEvent.type).toBe('artifact-update');
  });

  it('should construct artifacts with multiple parts', () => {
    const artifact: Artifact = {
      id: 'art_1',
      parts: [
        { type: 'text', text: 'Summary' },
        { type: 'data', mimeType: 'application/json', data: { total: 42 } },
      ],
      mimeType: 'multipart/mixed',
    };
    expect(artifact.parts).toHaveLength(2);
  });

  it('should support security schemes', () => {
    const card: AgentCard = {
      name: 'secure-agent',
      url: 'https://example.com/a2a',
      version: '0.3',
      capabilities: { streaming: false, pushNotifications: false },
      skills: [],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        apiKey: { type: 'apiKey', location: 'header', parameterName: 'X-API-Key' },
      },
      security: [{ bearer: [] }],
    };
    expect(card.securitySchemes).toBeDefined();
    expect(card.security).toHaveLength(1);
  });
});
