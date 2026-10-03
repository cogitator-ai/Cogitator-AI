import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { z } from 'zod';
import { Cogitator, CogitatorError, ErrorCode, tool } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import { MCPClient, MCPServer } from '@cogitator-ai/mcp';
import { createTestAgent, createTestCogitator, isOllamaRunning } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: one agent, many users', () => {
  let cogitator: Cogitator;
  const agent = createTestAgent({
    instructions:
      'You have perfect memory. Repeat codes the user told you exactly. Keep answers short.',
  });

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    cogitator = createTestCogitator({ memory: true });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it("keeps a user's conversation away from other users", async () => {
    const threadId = `alice_${Date.now()}`;
    await cogitator.run(agent, {
      input: 'My locker code is ZETA-4471. Remember it.',
      userId: 'alice',
      threadId,
    });

    const stolen = await cogitator
      .run(agent, { input: 'What is my locker code?', userId: 'bob', threadId })
      .catch((e: unknown) => e);
    const recalled = await cogitator.run(agent, {
      input: 'What is my locker code? Reply with the code only.',
      userId: 'alice',
      threadId,
    });

    expect(stolen).toBeInstanceOf(CogitatorError);
    expect((stolen as CogitatorError).code).toBe(ErrorCode.THREAD_ACCESS_DENIED);
    expect(recalled.output).toContain('4471');
  });

  it('scopes server thread routes to the authenticated user', async () => {
    const app = express();
    const server = new CogitatorServer({
      app,
      cogitator,
      agents: { assistant: agent },
      config: {
        basePath: '/cogitator',
        enableSwagger: false,
        auth: (req) => {
          const user = req.get('x-user');
          return user ? { userId: user } : undefined;
        },
      },
    });
    await server.init();
    const http: Server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const base = `http://localhost:${(http.address() as AddressInfo).port}/cogitator`;
    const as = (user: string, init: RequestInit = {}) => ({
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-user': user },
    });

    try {
      const run = await fetch(
        `${base}/agents/assistant/run`,
        as('alice', { method: 'POST', body: JSON.stringify({ input: 'Remember: blue fox.' }) })
      );
      const { threadId } = (await run.json()) as { threadId: string };

      const own = await fetch(`${base}/threads/${threadId}`, as('alice'));
      const foreign = await fetch(`${base}/threads/${threadId}`, as('bob'));
      const hijack = await fetch(
        `${base}/agents/assistant/run`,
        as('bob', { method: 'POST', body: JSON.stringify({ input: 'What did I say?', threadId }) })
      );
      const wipe = await fetch(`${base}/threads/${threadId}`, as('bob', { method: 'DELETE' }));

      expect(run.status).toBe(200);
      expect(own.status).toBe(200);
      expect(JSON.stringify(await own.json())).toContain('blue fox');
      expect(foreign.status).toBe(403);
      expect(hijack.status).toBe(403);
      expect(((await hijack.json()) as { error: { code: string } }).error.code).toBe(
        'THREAD_ACCESS_DENIED'
      );
      expect(wipe.status).toBe(403);
      expect((await fetch(`${base}/threads/${threadId}`, as('alice'))).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it('calls MCP tools with the credentials of the user it acts for', async () => {
    const callers: Array<string | undefined> = [];
    const balances: Record<string, number> = { alice: 120, bob: 75 };
    const mcp = new MCPServer({
      name: 'bank',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      auth: (request) => {
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        return token === 'tok-alice'
          ? { userId: 'alice' }
          : token === 'tok-bob'
            ? { userId: 'bob' }
            : undefined;
      },
    });
    mcp.registerTool(
      tool({
        name: 'get_my_balance',
        description: "Get the calling user's account balance in euros",
        parameters: z.object({}),
        execute: async (_args, context) => {
          callers.push(context.userId);
          return { balance: balances[context.userId ?? ''] ?? 0 };
        },
      })
    );
    await mcp.start();
    const client = await MCPClient.connect({
      transport: 'http',
      url: `http://127.0.0.1:${mcp.getPort()}/mcp`,
      headers: { Authorization: 'Bearer tok-bob' },
    });

    try {
      const banker = createTestAgent({
        instructions:
          'You answer balance questions. Always call get_my_balance first, then state the balance.',
        tools: await client.getTools(),
      });
      for (let attempt = 0; attempt < 5 && callers.length === 0; attempt++) {
        await cogitator.run(banker, { input: 'What is my balance?', userId: 'bob' });
      }

      expect(callers.length).toBeGreaterThan(0);
      expect(new Set(callers)).toEqual(new Set(['bob']));
      await expect(
        MCPClient.connect({ transport: 'http', url: `http://127.0.0.1:${mcp.getPort()}/mcp` })
      ).rejects.toThrow();
    } finally {
      await client.close();
      await mcp.stop();
    }
  });
});
