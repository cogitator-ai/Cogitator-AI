import { describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { openapi, secured } from '@tetsujs/openapi';
import { assertDescribed } from '@tetsujs/openapi/testing';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { callerHook, cogitatorController } from '../index.js';
import { chatAgent, fakeCogitator, fakeMemory, json } from './helpers.js';

const info = { title: 'Cogitator', version: '1.0.0' };

describe('OpenAPI document', () => {
  let fail = false;
  const { cogitator } = fakeCogitator(async () => {
    throw new CogitatorError({ message: 'Busy', code: ErrorCode.LLM_RATE_LIMITED });
  });
  const memory = fakeMemory();
  memory.getThread.mockImplementation((threadId) =>
    Promise.resolve({
      success: true,
      data:
        threadId === 'graces'
          ? {
              id: threadId,
              agentId: 'chat',
              metadata: { userId: 'grace' },
              createdAt: new Date(0),
              updatedAt: new Date(0),
            }
          : null,
    })
  );
  const app = createApp({
    routes: group('/api', {
      children: [
        cogitatorController({
          cogitator: Object.assign(cogitator, { memory }),
          agents: { chat: chatAgent() },
          auth: secured(
            callerHook(() => (fail ? undefined : { userId: 'ada' })),
            {
              name: 'bearerAuth',
              scheme: { type: 'http', scheme: 'bearer' },
              error: 'UNAUTHORIZED',
            }
          ),
          authorizeThread: (_auth, threadId) => threadId !== 'private',
          websocket: true,
        }),
      ],
    }),
  });
  const { document, warnings } = openapi(app, { info });
  const request = serve(app);

  test('describes every route without warnings', () => {
    expect(warnings).toEqual([]);
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      '/api/agents',
      '/api/agents/{name}/run',
      '/api/agents/{name}/stream',
      '/api/health',
      '/api/ready',
      '/api/swarms',
      '/api/swarms/{name}/blackboard',
      '/api/swarms/{name}/run',
      '/api/swarms/{name}/stream',
      '/api/threads/{id}',
      '/api/threads/{id}/messages',
      '/api/tools',
      '/api/workflows',
      '/api/workflows/{name}/run',
      '/api/workflows/{name}/stream',
    ]);
  });

  test('documents the security scheme on guarded routes only', () => {
    expect(document.components?.securitySchemes?.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.paths?.['/api/agents']?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths?.['/api/health']?.get?.security).toBeUndefined();
  });

  test('names operations after the controller', () => {
    expect(document.paths?.['/api/agents/{name}/run']?.post?.operationId).toBe('cogitatorRunAgent');
    expect(document.paths?.['/api/threads/{id}']?.delete?.operationId).toBe(
      'cogitatorDeleteThread'
    );
  });

  test('answers as the document says', async () => {
    const cases: Array<[string, string, RequestInit?]> = [
      ['GET /api/health', '/api/health'],
      ['GET /api/agents', '/api/agents'],
      ['GET /api/tools', '/api/tools'],
      ['POST /api/agents/chat/run', '/api/agents/chat/run', json({ input: 'hi' })],
      ['POST /api/agents/ghost/run', '/api/agents/ghost/run', json({ input: 'hi' })],
      ['POST /api/agents/chat/run', '/api/agents/chat/run', json({ input: '' })],
      [
        'POST /api/agents/chat/run',
        '/api/agents/chat/run',
        json({ input: 'hi', threadId: 'private' }),
      ],
      ['GET /api/threads/t-1', '/api/threads/t-1'],
      ['DELETE /api/threads/t-1', '/api/threads/t-1', { method: 'DELETE' }],
      [
        'POST /api/threads/t-1/messages',
        '/api/threads/t-1/messages',
        json({ role: 'user', content: 'hi' }),
      ],
      ['GET /api/workflows', '/api/workflows'],
      ['POST /api/workflows/ghost/run', '/api/workflows/ghost/run', json({})],
      ['GET /api/swarms', '/api/swarms'],
      ['GET /api/swarms/ghost/blackboard', '/api/swarms/ghost/blackboard'],
    ];

    for (const [operation, path, init] of cases) {
      await assertDescribed(document, operation, await request(path, init));
    }
  });

  test("describes the refusal of another user's thread", async () => {
    const cases: Array<[string, string, RequestInit?]> = [
      ['GET /api/threads/graces', '/api/threads/graces'],
      ['DELETE /api/threads/graces', '/api/threads/graces', { method: 'DELETE' }],
      [
        'POST /api/threads/graces/messages',
        '/api/threads/graces/messages',
        json({ role: 'user', content: 'hi' }),
      ],
    ];

    for (const [operation, path, init] of cases) {
      const res = await request(path, init);
      expect(res.status).toBe(403);
      await assertDescribed(document, operation, res);
    }
  });

  test('describes a refused caller', async () => {
    fail = true;
    try {
      await assertDescribed(document, 'GET /api/agents', await request('/api/agents'));
    } finally {
      fail = false;
    }
  });
});
