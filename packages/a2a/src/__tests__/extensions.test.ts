import { describe, it, expect, afterEach } from 'vitest';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import {
  RUN_TIMEOUT_EXTENSION,
  TOOL_APPROVALS_EXTENSION,
  activatedExtensions,
  missingRequiredExtensions,
  parseExtensionsHeader,
  runTimeoutFromMetadata,
} from '../extensions';
import { A2AError } from '../errors';
import { expectResponse, userMessage } from './helpers';
import {
  echoCogitator,
  mockAgent,
  rpc,
  serveExpress,
  v1UserMessage,
  type Served,
} from './v1-helpers';

const GEO = 'https://example.com/extensions/geo/v1';

describe('extension helpers', () => {
  it('parses the A2A-Extensions header', () => {
    expect(parseExtensionsHeader(` ${GEO}, ${TOOL_APPROVALS_EXTENSION},,${GEO}`)).toEqual([
      GEO,
      TOOL_APPROVALS_EXTENSION,
    ]);
    expect(parseExtensionsHeader(undefined)).toEqual([]);
  });

  it('finds required extensions a request did not ask for, and the ones it activates', () => {
    const declared = [{ uri: GEO, required: true }, { uri: TOOL_APPROVALS_EXTENSION }];
    expect(missingRequiredExtensions(declared, [])).toEqual([GEO]);
    expect(missingRequiredExtensions(declared, [GEO])).toEqual([]);
    expect(activatedExtensions(declared, [GEO, 'https://unknown/v1'])).toEqual([GEO]);
  });

  it('reads the run timeout of the run-timeout extension and refuses a bad one', () => {
    expect(runTimeoutFromMetadata({ [RUN_TIMEOUT_EXTENSION]: { timeoutMs: 500 } })).toBe(500);
    expect(runTimeoutFromMetadata({ other: 1 })).toBeUndefined();
    expect(() => runTimeoutFromMetadata({ [RUN_TIMEOUT_EXTENSION]: { timeoutMs: -1 } })).toThrow(
      A2AError
    );
  });
});

describe('extensions on the wire', () => {
  let served: Served | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it('refuses a message without a required extension: -32008 over JSON-RPC, 400 over REST', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      extensions: [{ uri: GEO, description: 'Location', required: true }],
    });
    const refused = await rpc(`${served.url}/a2a`, 'SendMessage', { message: v1UserMessage('hi') });
    expect(refused.body.error?.code).toBe(-32008);
    expect(refused.body.error?.data).toContainEqual(
      expect.objectContaining({
        reason: 'EXTENSION_SUPPORT_REQUIRED',
        metadata: { extensions: GEO },
      })
    );

    const legacy = await rpc(
      `${served.url}/a2a`,
      'message/send',
      { message: userMessage('hi') },
      {}
    );
    expect(legacy.body.error?.code).toBe(-32008);

    const rest = await fetch(`${served.url}/a2a/rest/message:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ message: v1UserMessage('hi') }),
    });
    expect(rest.status).toBe(400);

    const accepted = await rpc(
      `${served.url}/a2a`,
      'SendMessage',
      { message: v1UserMessage('hi') },
      { 'A2A-Version': '1.0', 'A2A-Extensions': GEO }
    );
    expect(accepted.body.error).toBeUndefined();
    expect(accepted.headers.get('a2a-extensions')).toBe(GEO);
  });

  it('echoes the activated extensions, X-A2A-Extensions in 0.3', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const v1 = await rpc(
      `${served.url}/a2a`,
      'ListTasks',
      {},
      { 'A2A-Version': '1.0', 'A2A-Extensions': `${TOOL_APPROVALS_EXTENSION}, https://unknown/v1` }
    );
    expect(v1.headers.get('a2a-extensions')).toBe(TOOL_APPROVALS_EXTENSION);

    const legacy = await rpc(
      `${served.url}/a2a`,
      'tasks/list',
      {},
      { 'X-A2A-Extensions': TOOL_APPROVALS_EXTENSION }
    );
    expect(legacy.headers.get('x-a2a-extensions')).toBe(TOOL_APPROVALS_EXTENSION);
    expect(legacy.headers.get('a2a-extensions')).toBeNull();

    const none = await rpc(`${served.url}/a2a`, 'ListTasks', {});
    expect(none.headers.get('a2a-extensions')).toBeNull();
  });

  it('takes the run timeout from the run-timeout metadata in 1.0', async () => {
    const cogitator = echoCogitator();
    const server = new A2AServer({ agents: { helper: mockAgent('helper') }, cogitator });
    expectResponse(
      await server.handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: v1UserMessage('timed'),
            metadata: { [RUN_TIMEOUT_EXTENSION]: { timeoutMs: 1234 } },
          },
        },
        undefined,
        { protocolVersion: '1.0' }
      )
    );
    expect(cogitator.timeouts.at(-1)).toBe(1234);

    const bad = expectResponse(
      await server.handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'SendMessage',
          params: {
            message: v1UserMessage('timed'),
            metadata: { [RUN_TIMEOUT_EXTENSION]: { timeoutMs: 'soon' } },
          },
        },
        undefined,
        { protocolVersion: '1.0' }
      )
    );
    expect(bad.error?.code).toBe(-32602);
  });

  it('lets the client ask for extensions and send its run timeout over 1.0', async () => {
    const cogitator = echoCogitator();
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator,
      extensions: [{ uri: GEO, required: true }],
    });
    const client = new A2AClient(served.url, { extensions: [GEO] });
    const result = await client.sendMessage(
      { role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
      { timeout: 4321 }
    );
    expect(result.kind).toBe('task');
    expect(cogitator.timeouts.at(-1)).toBe(4321);
  });
});
