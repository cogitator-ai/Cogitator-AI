import { code, tsString } from '../code.js';
import { runScript } from '../package-manager.js';
import type { ProjectBuilder } from '../project.js';
import { hasFeature, type ServerFramework } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import type { FeatureModule } from './types.js';

function a2aServerTs(project: ProjectBuilder): string {
  return code`
    import { timingSafeEqual } from 'node:crypto';
    import type { Cogitator } from '@cogitator-ai/core';
    import { A2AServer } from '@cogitator-ai/a2a';
    import { agents, cogitator } from '../cogitator.js';

    function sameToken(given: string, expected: string): boolean {
      const a = Buffer.from(given);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    }

    /**
     * Every agent of the registry over the Agent-to-Agent protocol (v0.3): other
     * frameworks discover them at /.well-known/agent-card.json and talk JSON-RPC at
     * /a2a. With \`token\` set, they need \`Authorization: Bearer <token>\`.
     */
    export function createA2AServer(runtime: Cogitator, token: string | undefined = process.env.A2A_TOKEN) {
      return new A2AServer({
        agents,
        cogitator: runtime,
        provider: { organization: ${tsString(project.spec.name)}, url: 'https://github.com/cogitator-ai/Cogitator-AI' },
        ...(token && {
          auth: { type: 'bearer' as const, validate: async (given: string) => sameToken(given, token) },
        }),
      });
    }

    export const a2aServer = createA2AServer(cogitator);
  `;
}

const A2A_ASK_TS = code`
  import { A2AClient } from '@cogitator-ai/a2a';

  function textOf(parts: ReadonlyArray<{ kind: string; text?: string }> | undefined): string {
    return (parts ?? []).map((part) => (part.kind === 'text' ? (part.text ?? '') : '')).join('');
  }

  /**
   * Asks an A2A agent a question: this project's own server by default, or any
   * A2A v0.3 agent at A2A_URL, built with Cogitator or with another framework.
   */
  async function main(): Promise<void> {
    const question = process.argv.slice(2).join(' ').trim() || 'What can you do?';
    const token = process.env.A2A_TOKEN;
    const client = new A2AClient(process.env.A2A_URL ?? 'http://localhost:3000', {
      ...(token && { headers: { authorization: \`Bearer \${token}\` } }),
      timeout: 120_000,
    });

    const card = await client.agentCard();
    console.error(\`Asking \${card.name}: \${card.description}\`);

    const result = await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: question }] });
    if (result.kind === 'message') {
      console.log(textOf(result.parts));
      return;
    }
    const answer =
      textOf(result.status.message?.parts) ||
      (result.artifacts ?? []).map((artifact) => textOf(artifact.parts)).join('\\n');
    console.log(answer || \`The task ended as \${result.status.state}\`);
  }

  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
`;

const A2A_TEST_TS = code`
  import { describe, expect, it } from 'vitest';
  import { createA2AServer } from '../src/a2a/server.js';
  import { mockCogitator } from './helpers.js';

  function send(text: string) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', messageId: 'm-1', role: 'user', parts: [{ kind: 'text', text }] } },
    };
  }

  describe('A2A server', () => {
    it('describes the assistant in an A2A v0.3 agent card', () => {
      const { cogitator } = mockCogitator();
      const card = createA2AServer(cogitator, undefined).getAgentCard('assistant', {
        baseUrl: 'http://localhost:3000',
      });
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.name).toBe('assistant');
    });

    it('answers a message with the agent', async () => {
      const { cogitator } = mockCogitator({ content: 'Hello over A2A' });
      try {
        const response = await createA2AServer(cogitator, undefined).handleJsonRpc(send('Hi'));
        expect(JSON.stringify(response)).toContain('Hello over A2A');
      } finally {
        await cogitator.close();
      }
    });

    it('refuses a caller without the token', async () => {
      const { cogitator } = mockCogitator({ content: 'secret' });
      const server = createA2AServer(cogitator, 'a2a-token');
      const refused = await server.handleJsonRpc(send('Hi'));
      expect(JSON.stringify(refused)).toContain('Unauthorized');
      const allowed = await server.handleJsonRpc(send('Hi'), 'a2a-token');
      expect(JSON.stringify(allowed)).toContain('secret');
      await cogitator.close();
    });
  });
`;

/** The imports and mount statements that put the A2A routes on a server's app. */
export function a2aMount(server: ServerFramework): { imports: string[]; mount: string } {
  switch (server) {
    case 'hono':
      return {
        imports: [
          "import { a2aHono } from '@cogitator-ai/a2a/hono';",
          "import { a2aServer } from './a2a/server.js';",
        ],
        mount: "app.route('/', a2aHono(a2aServer));",
      };
    case 'express':
      return {
        imports: [
          "import { a2aExpress } from '@cogitator-ai/a2a/express';",
          "import { a2aServer } from './a2a/server.js';",
        ],
        mount: 'app.use(a2aExpress(a2aServer));',
      };
    case 'fastify':
      return {
        imports: [
          "import { a2aFastify } from '@cogitator-ai/a2a/fastify';",
          "import { a2aServer } from './a2a/server.js';",
        ],
        mount: 'await app.register(a2aFastify(a2aServer));',
      };
    case 'koa':
      return {
        imports: [
          "import { bodyParser } from '@koa/bodyparser';",
          "import { a2aKoa } from '@cogitator-ai/a2a/koa';",
          "import { a2aServer } from './a2a/server.js';",
        ],
        mount: code`
          const a2aBody = bodyParser();
          app.use((ctx, next) => (ctx.path.startsWith('/a2a') ? a2aBody(ctx, next) : next()));
          app.use(a2aKoa(a2aServer));
        `,
      };
    case 'tetsu':
      throw new Error('A2A has no Tetsu adapter, which compatibilityIssues rules out');
  }
}

/** The agents served over the Agent-to-Agent protocol, next to the REST API. */
export const a2aFeature: FeatureModule = {
  id: 'feature:a2a',
  applies: (spec) => hasFeature(spec, 'a2a'),
  apply(project) {
    const { spec } = project;
    project
      .dependency('@cogitator-ai/a2a', cogitatorVersion('@cogitator-ai/a2a'))
      .file('src/a2a/server.ts', a2aServerTs(project))
      .file('src/a2a/ask.ts', A2A_ASK_TS)
      .file('tests/a2a.test.ts', A2A_TEST_TS)
      .envVar({
        name: 'A2A_TOKEN',
        description: 'Bearer token A2A callers need, open to anyone without it',
        required: false,
        secret: true,
      })
      .envVar({
        name: 'A2A_URL',
        description: 'The A2A agent the a2a:ask script talks to',
        example: 'http://localhost:3000',
        required: false,
        secret: false,
      });
    if (spec.server === 'koa') project.dependency('@koa/bodyparser', VERSIONS.koaBodyparser);
    if (spec.app !== 'next')
      project.script('a2a:ask', 'tsx --env-file-if-exists=.env src/a2a/ask.ts');
  },
  finalize(project) {
    const pm = project.spec.packageManager;
    project.section(
      'A2A',
      code`
        \`src/a2a/server.ts\` serves every agent of the registry over the Agent-to-Agent protocol v0.3, so agents built with other frameworks can call them: the card is at \`/.well-known/agent-card.json\`, JSON-RPC at \`/a2a\` (\`/a2a/<agent>\` for each agent). Set \`A2A_TOKEN\` to require a bearer token. \`${runScript(pm, 'a2a:ask', '"your question"')}\` asks an A2A agent, this project's by default or any at \`A2A_URL\`.
      `
    );
  },
};
