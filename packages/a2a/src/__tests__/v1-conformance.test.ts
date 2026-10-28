import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { AgentCard } from '../types';
import { sendMessageRequestToV1 } from '../v1/translate';
import type { V1StreamResponse, V1Task } from '../v1/types';
import {
  echoCogitator,
  mockAgent,
  rpc,
  serveExpress,
  sseData,
  v1UserMessage,
  type Served,
} from './v1-helpers';

/**
 * Wire conformance with A2A protocol 1.0. Every payload is validated against the official JSON
 * schema bundle (https://a2a-protocol.org/v1.0.0/spec/a2a.json), whose definitions refer to each
 * other as `lf.a2a.v1.<Name>.jsonschema.json`.
 */
const bundle = JSON.parse(
  readFileSync(new URL('./fixtures/a2a-v1.0.0.schema.json', import.meta.url), 'utf8')
) as { definitions: Record<string, Record<string, unknown>> };

const ajv = new Ajv2020({ strict: false, allErrors: true });
const GOOGLE_TYPES = new Set(['Struct', 'Timestamp', 'Value']);
for (const [title, definition] of Object.entries(bundle.definitions)) {
  const name = title.replace(/ /g, '');
  const id = GOOGLE_TYPES.has(title)
    ? `google.protobuf.${name}.jsonschema.json`
    : `lf.a2a.v1.${name}.jsonschema.json`;
  ajv.addSchema({ ...definition, $id: id });
}
const validators = new Map<string, ValidateFunction>();

function expectValid(name: string, value: unknown): void {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.getSchema(`lf.a2a.v1.${name}.jsonschema.json`);
    if (!validate) throw new Error(`No schema for ${name}`);
    validators.set(name, validate);
  }
  const valid = validate(value);
  expect(
    valid,
    `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value, null, 2)}`
  ).toBe(true);
}

function isValid(name: string, value: unknown): boolean {
  return ajv.getSchema(`lf.a2a.v1.${name}.jsonschema.json`)!(value) === true;
}

describe('A2A 1.0 schema fixture', () => {
  it('rejects the A2A 0.3 form, so the checks below mean something', () => {
    expect(
      isValid('Task', { kind: 'task', id: 't', contextId: 'c', status: { state: 'completed' } })
    ).toBe(false);
    expect(isValid('Part', { kind: 'text', text: 'x' })).toBe(false);
    expect(isValid('Part', { text: 'x' })).toBe(true);
  });
});

describe('A2A 1.0 wire conformance', () => {
  let served: Served;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  beforeAll(async () => {
    const generated: { card?: AgentCard } = {};
    served = await serveExpress({
      agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
      cogitator: echoCogitator(),
      allowPrivateUrls: true,
      auth: { type: 'bearer', validate: async () => true },
      provider: { organization: 'Cogitator', url: 'https://cogitator.app' },
      cardSigning: { alg: 'ES256', privateKey, kid: 'k1' },
      extendedCardGenerator: (name) => {
        generated.card ??= served.server.getAgentCard(name);
        return { ...generated.card, description: 'extended' };
      },
    });
  });

  afterAll(async () => {
    await served.close();
  });

  const headers = { 'A2A-Version': '1.0', Authorization: 'Bearer t' };

  it('serves an Agent Card the schema accepts', async () => {
    const card = await (
      await fetch(`${served.url}/a2a/writer/.well-known/agent-card.json`, { headers })
    ).json();
    expectValid('AgentCard', card);
    const extended = await rpc(`${served.url}/a2a`, 'GetExtendedAgentCard', {}, headers);
    expectValid('AgentCard', extended.body.result);
  });

  it('answers SendMessage, GetTask and ListTasks as the schema says', async () => {
    const sent = await rpc(
      `${served.url}/a2a`,
      'SendMessage',
      {
        message: v1UserMessage('hello', {
          parts: [
            { text: 'hello', mediaType: 'text/plain' },
            { data: { city: 'Riga' } },
            { data: 7 },
            { url: 'https://files.example/a.pdf', mediaType: 'application/pdf', filename: 'a.pdf' },
            { raw: 'aGVsbG8=', mediaType: 'application/octet-stream' },
          ],
          metadata: { trace: 'x' },
        }),
      },
      headers
    );
    expectValid('SendMessageResponse', sent.body.result);
    const task = (sent.body.result as { task: V1Task }).task;

    const fetched = await rpc(`${served.url}/a2a`, 'GetTask', { id: task.id }, headers);
    expectValid('Task', fetched.body.result);

    const listed = await rpc(
      `${served.url}/a2a`,
      'ListTasks',
      { pageSize: 10, includeArtifacts: true },
      headers
    );
    expectValid('ListTasksResponse', listed.body.result);
  });

  it('streams StreamResponse objects the schema accepts', async () => {
    const response = await fetch(`${served.url}/a2a/rest/message:stream`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/a2a+json' },
      body: JSON.stringify({ message: v1UserMessage('stream') }),
    });
    const events = (await sseData(response)) as V1StreamResponse[];
    expect(events.length).toBeGreaterThan(2);
    for (const event of events) expectValid('StreamResponse', event);
  });

  it('answers the push notification methods as the schema says', async () => {
    const sent = await rpc(
      `${served.url}/a2a`,
      'SendMessage',
      { message: v1UserMessage('p') },
      headers
    );
    const taskId = (sent.body.result as { task: V1Task }).task.id;
    const created = await rpc(
      `${served.url}/a2a`,
      'CreateTaskPushNotificationConfig',
      {
        taskId,
        url: 'https://hooks.example.com',
        authentication: { scheme: 'Bearer', credentials: 'c' },
      },
      headers
    );
    expectValid('TaskPushNotificationConfig', created.body.result);
    const listed = await rpc(
      `${served.url}/a2a`,
      'ListTaskPushNotificationConfigs',
      { taskId },
      headers
    );
    expectValid('ListTaskPushNotificationConfigsResponse', listed.body.result);
  });

  it('sends requests from the client the schema accepts', () => {
    expectValid(
      'SendMessageRequest',
      sendMessageRequestToV1(
        {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [
              { kind: 'text', text: 'hi' },
              { kind: 'file', file: { uri: 'https://f.example/x', mimeType: 'text/csv' } },
            ],
            contextId: 'ctx',
          },
          configuration: {
            historyLength: 2,
            blocking: false,
            timeout: 1000,
            pushNotificationConfig: { url: 'https://hooks.example.com', token: 't' },
          },
        },
        'helper'
      )
    );
  });
});
