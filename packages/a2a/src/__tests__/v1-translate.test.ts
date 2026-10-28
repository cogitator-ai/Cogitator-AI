import { describe, it, expect } from 'vitest';
import {
  cardModelFromLegacy,
  cardModelFromV1,
  legacyCardFromV1,
  toLegacyCard,
  toV1Card,
  type AgentCardModel,
} from '../agent-card';
import {
  DATA_VALUE_KEY,
  messageFromV1,
  messageToV1,
  partFromV1,
  partToV1,
  pushConfigFromV1,
  pushConfigToV1,
  securitySchemeFromV1,
  securitySchemeToV1,
  sendMessageRequestFromV1,
  sendMessageRequestToV1,
  streamEventFromV1,
  streamEventToV1,
  taskFromV1,
  taskStateFromV1,
  taskStateToV1,
  taskToV1,
} from '../v1/translate';
import { parseSendMessageRequest, readAgentCard, readStreamResponse, readTask } from '../v1/schema';
import { RUN_TIMEOUT_EXTENSION } from '../extensions';
import type {
  A2AMessage,
  A2AStreamEvent,
  A2ATask,
  Part,
  SecurityScheme,
  TaskState,
} from '../types';
import type { V1Part } from '../v1/types';

const STATES: TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
];

describe('translation between the internal model and A2A 1.0', () => {
  it('maps every task state both ways', () => {
    for (const state of STATES) expect(taskStateFromV1(taskStateToV1(state))).toBe(state);
    expect(taskStateToV1('unknown')).toBe('TASK_STATE_UNSPECIFIED');
  });

  it.each<[string, Part, V1Part]>([
    ['text', { kind: 'text', text: 'hi', metadata: { a: 1 } }, { text: 'hi', metadata: { a: 1 } }],
    [
      'file by url',
      {
        kind: 'file',
        file: { uri: 'https://f.example/x.pdf', mimeType: 'application/pdf', name: 'x.pdf' },
      },
      { url: 'https://f.example/x.pdf', mediaType: 'application/pdf', filename: 'x.pdf' },
    ],
    ['file bytes', { kind: 'file', file: { bytes: 'aGk=' } }, { raw: 'aGk=' }],
    ['object data', { kind: 'data', data: { a: [1, 2] } }, { data: { a: [1, 2] } }],
    [
      'scalar data',
      { kind: 'data', data: { value: 'yes' }, metadata: { [DATA_VALUE_KEY]: true } },
      { data: 'yes' },
    ],
    [
      'null data',
      { kind: 'data', data: { value: null }, metadata: { [DATA_VALUE_KEY]: true, keep: 1 } },
      { data: null, metadata: { keep: 1 } },
    ],
  ])('round-trips a %s part', (_name, internal, v1) => {
    expect(partToV1(internal)).toEqual(v1);
    expect(partFromV1(v1)).toEqual(internal);
  });

  it('round-trips a message with every field', () => {
    const message: A2AMessage = {
      kind: 'message',
      messageId: 'm1',
      role: 'agent',
      parts: [{ kind: 'text', text: 'hello' }],
      taskId: 't1',
      contextId: 'c1',
      referenceTaskIds: ['t0'],
      extensions: ['https://ext/v1'],
      metadata: { k: 'v' },
    };
    const v1 = messageToV1(message);
    expect(v1.role).toBe('ROLE_AGENT');
    expect(v1).not.toHaveProperty('kind');
    expect(messageFromV1(v1)).toEqual(message);
  });

  it('round-trips a task, leaving empty history and artifacts out', () => {
    const task: A2ATask = {
      kind: 'task',
      id: 't1',
      contextId: 'c1',
      status: {
        state: 'input-required',
        timestamp: '2026-10-28T10:00:00.000Z',
        message: {
          kind: 'message',
          messageId: 'q',
          role: 'agent',
          parts: [{ kind: 'text', text: '?' }],
        },
      },
      history: [],
      artifacts: [{ artifactId: 'a1', name: 'Reply', parts: [{ kind: 'text', text: 'x' }] }],
      metadata: { public: true },
    };
    const v1 = taskToV1(task);
    expect(v1).not.toHaveProperty('history');
    expect(v1.status.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const { history: _history, ...withoutHistory } = task;
    expect(taskFromV1(readTask(JSON.parse(JSON.stringify(v1))))).toEqual(withoutHistory);
  });

  it('round-trips stream events, computing final from the state', () => {
    const events: A2AStreamEvent[] = [
      {
        kind: 'status-update',
        taskId: 't',
        contextId: 'c',
        status: { state: 'working' },
        final: false,
      },
      {
        kind: 'status-update',
        taskId: 't',
        contextId: 'c',
        status: { state: 'auth-required' },
        final: true,
      },
      {
        kind: 'artifact-update',
        taskId: 't',
        contextId: 'c',
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'chunk' }] },
        append: true,
        lastChunk: true,
      },
    ];
    for (const event of events) {
      const v1 = streamEventToV1(event);
      expect(JSON.stringify(v1)).not.toContain('final');
      expect(streamEventFromV1(readStreamResponse(JSON.parse(JSON.stringify(v1))))).toEqual(event);
    }
  });

  it('maps push configs: one scheme in 1.0, a list in 0.3', () => {
    const v1 = pushConfigToV1(
      {
        url: 'https://h.example',
        id: 'p1',
        token: 't',
        authentication: { schemes: ['Bearer', 'Basic'], credentials: 'c' },
        protocolVersion: '1.0',
      },
      'task_1'
    );
    expect(v1).toEqual({
      id: 'p1',
      taskId: 'task_1',
      url: 'https://h.example',
      token: 't',
      authentication: { scheme: 'Bearer', credentials: 'c' },
    });
    expect(pushConfigFromV1(v1)).toEqual({
      url: 'https://h.example',
      id: 'p1',
      token: 't',
      authentication: { schemes: ['Bearer'], credentials: 'c' },
    });
  });

  it('maps SendMessage requests: returnImmediately, push config, run timeout', () => {
    const request = parseSendMessageRequest({
      tenant: 'helper',
      message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
      configuration: {
        acceptedOutputModes: ['text/plain'],
        historyLength: '3',
        returnImmediately: true,
        taskPushNotificationConfig: { url: 'https://h.example' },
      },
      metadata: { [RUN_TIMEOUT_EXTENSION]: { timeoutMs: 900 } },
    });
    const internal = sendMessageRequestFromV1(request);
    expect(internal.configuration).toEqual({
      acceptedOutputModes: ['text/plain'],
      historyLength: 3,
      blocking: false,
      pushNotificationConfig: { url: 'https://h.example', protocolVersion: '1.0' },
      timeout: 900,
    });
    const back = sendMessageRequestToV1(internal, 'helper');
    expect(back.tenant).toBe('helper');
    expect(back.configuration).toEqual({
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: { url: 'https://h.example' },
      historyLength: 3,
      returnImmediately: true,
    });
    expect(back.metadata).toEqual({ [RUN_TIMEOUT_EXTENSION]: { timeoutMs: 900 } });
  });

  it.each<SecurityScheme>([
    { type: 'apiKey', in: 'query', name: 'key', description: 'Key' },
    { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    {
      type: 'openIdConnect',
      openIdConnectUrl: 'https://id.example/.well-known/openid-configuration',
    },
    { type: 'mutualTLS' },
    {
      type: 'oauth2',
      flows: {
        clientCredentials: { tokenUrl: 'https://auth.example/token', scopes: { read: 'Read' } },
      },
      oauth2MetadataUrl: 'https://auth.example/.well-known/oauth-authorization-server',
    },
    {
      type: 'oauth2',
      flows: {
        deviceCode: {
          deviceAuthorizationUrl: 'https://auth.example/device',
          tokenUrl: 'https://auth.example/token',
          scopes: {},
        },
      },
    },
  ])('round-trips the security scheme %j', (scheme) => {
    const v1 = securitySchemeToV1(scheme);
    expect(v1).toBeDefined();
    expect(securitySchemeFromV1(v1!)).toEqual(scheme);
  });

  it('keeps one OAuth flow in 1.0, the first by priority', () => {
    const v1 = securitySchemeToV1({
      type: 'oauth2',
      flows: {
        implicit: { authorizationUrl: 'https://a.example', scopes: {} },
        authorizationCode: {
          authorizationUrl: 'https://a.example/authorize',
          tokenUrl: 'https://a.example/token',
          scopes: {},
        },
      },
    });
    expect(
      v1 && 'oauth2SecurityScheme' in v1 && Object.keys(v1.oauth2SecurityScheme.flows)
    ).toEqual(['authorizationCode']);
  });
});

describe('Agent Card model', () => {
  const model: AgentCardModel = {
    name: 'helper',
    description: 'Helps',
    version: '2.0.0',
    provider: { organization: 'Org', url: 'https://org.example' },
    iconUrl: 'https://org.example/icon.png',
    documentationUrl: 'https://org.example/docs',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [{ uri: 'https://ext/v1', required: true }],
      extendedAgentCard: true,
    },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 's', name: 'S', description: 'Skill', tags: ['t'], security: [{ bearer: ['x'] }] },
    ],
    interfaces: [
      {
        url: 'https://a.example/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: 'helper',
      },
      {
        url: 'https://a.example/a2a/rest',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
        tenant: 'helper',
      },
      { url: 'https://a.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ],
  };

  it('renders a hybrid card a model can be read back from', () => {
    const hybrid = toLegacyCard(model, { embedInterfaces: true });
    expect(hybrid).toMatchObject({
      protocolVersion: '0.3.0',
      url: 'https://a.example/a2a',
      preferredTransport: 'JSONRPC',
      supportsAuthenticatedExtendedCard: true,
    });
    expect(toV1Card(cardModelFromLegacy(hybrid))).toEqual(toV1Card(model));
  });

  it('reads a 1.0 card back into the same model and the same 1.0 card', () => {
    const v1 = toV1Card(model);
    expect(v1.skills[0].securityRequirements).toEqual([{ schemes: { bearer: { list: ['x'] } } }]);
    expect(toV1Card(cardModelFromV1(readAgentCard(JSON.parse(JSON.stringify(v1)))))).toEqual(v1);
  });

  it('turns a 1.0 card into the 0.3 form the client API speaks', () => {
    const legacy = legacyCardFromV1(toV1Card(model));
    expect(legacy).toMatchObject({
      protocolVersion: '0.3.0',
      url: 'https://a.example/a2a',
      preferredTransport: 'JSONRPC',
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
    });
    expect(legacy.supportedInterfaces).toHaveLength(3);

    const modernOnly = legacyCardFromV1(
      toV1Card({ ...model, interfaces: model.interfaces.slice(1, 2) })
    );
    expect(modernOnly).toMatchObject({
      protocolVersion: '1.0',
      url: 'https://a.example/a2a/rest',
      preferredTransport: 'HTTP+JSON',
      additionalInterfaces: [{ transport: 'HTTP+JSON', url: 'https://a.example/a2a/rest' }],
    });
  });
});
