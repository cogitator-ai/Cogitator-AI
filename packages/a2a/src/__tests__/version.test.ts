import { describe, it, expect, afterEach } from 'vitest';
import { A2AError } from '../errors';
import { normalizeProtocolVersion, resolveProtocolVersion } from '../version';
import type { V1ErrorDetail } from '../v1/types';
import { echoCogitator, mockAgent, rpc, serveExpress, type Served } from './v1-helpers';

describe('protocol version negotiation', () => {
  it('reads Major.Minor and ignores a patch number', () => {
    expect(normalizeProtocolVersion('1.0')).toBe('1.0');
    expect(normalizeProtocolVersion(' 1.0.1 ')).toBe('1.0');
    expect(normalizeProtocolVersion('0.3.0')).toBe('0.3');
    expect(normalizeProtocolVersion('')).toBe('');
    expect(normalizeProtocolVersion(undefined)).toBe('');
    expect(normalizeProtocolVersion('v1')).toBe('v1');
  });

  it('takes an empty version as 0.3 and refuses what the server does not speak', () => {
    expect(resolveProtocolVersion(undefined, ['1.0', '0.3'])).toBe('0.3');
    expect(resolveProtocolVersion('1.0', ['1.0', '0.3'])).toBe('1.0');
    expect(() => resolveProtocolVersion('', ['1.0'])).toThrow(A2AError);
    try {
      resolveProtocolVersion('2.0', ['1.0', '0.3']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(A2AError);
      expect((error as A2AError).jsonRpcError).toEqual({
        code: -32009,
        message: 'A2A protocol version 2.0 is not supported, supported versions: 1.0, 0.3',
        data: { requestedVersion: '2.0', supportedVersions: ['1.0', '0.3'] },
      });
    }
  });
});

describe('protocol versions over HTTP', () => {
  let served: Served | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it('answers an unsupported version with -32009 naming the supported ones', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const reply = await rpc(`${served.url}/a2a`, 'GetTask', { id: 'x' }, { 'A2A-Version': '0.5' });
    expect(reply.body.id).toBe(1);
    expect(reply.body.error?.code).toBe(-32009);
    expect(reply.body.error?.data).toEqual([
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'VERSION_NOT_SUPPORTED',
        domain: 'a2a-protocol.org',
        metadata: { requestedVersion: '0.5', supportedVersions: '1.0,0.3' },
      },
    ] satisfies V1ErrorDetail[]);
  });

  it('routes by version on one endpoint: no header is 0.3, 1.0 by header or query', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const legacy = await rpc(`${served.url}/a2a`, 'tasks/list', {}, {});
    expect(legacy.body.result).toEqual({ tasks: [] });
    const legacyPascal = await rpc(`${served.url}/a2a`, 'ListTasks', {}, {});
    expect(legacyPascal.body.error?.code).toBe(-32601);

    const byHeader = await rpc(`${served.url}/a2a`, 'ListTasks', {});
    expect(byHeader.body.result).toEqual({
      tasks: [],
      nextPageToken: '',
      pageSize: 50,
      totalSize: 0,
    });
    const byQuery = await rpc(`${served.url}/a2a?A2A-Version=1.0`, 'ListTasks', {}, {});
    expect(byQuery.body.result).toMatchObject({ nextPageToken: '' });
  });

  it('refuses requests without a version when 0.3 is off, and 1.0 when 1.0 is off', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      protocolVersions: ['1.0'],
    });
    const unversioned = await rpc(`${served.url}/a2a`, 'tasks/list', {}, {});
    expect(unversioned.body.error?.code).toBe(-32009);
    await served.close();

    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      protocolVersions: ['0.3'],
    });
    const v1 = await rpc(`${served.url}/a2a`, 'ListTasks', {});
    expect(v1.body.error?.code).toBe(-32009);
    const rest = await fetch(`${served.url}/a2a/rest/tasks`, { headers: { 'A2A-Version': '1.0' } });
    expect(rest.status).toBe(404);
  });
});
