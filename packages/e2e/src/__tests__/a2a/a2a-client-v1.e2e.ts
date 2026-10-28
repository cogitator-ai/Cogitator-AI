import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, artifactText, type A2AStreamEvent } from '@cogitator-ai/a2a';
import type { Cogitator } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from '../../helpers/setup';
import { asTask, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

describeE2E('A2AClient over A2A 1.0', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;

  beforeAll(async () => {
    cogitator = createTestCogitator();
    const agent = (name: string) =>
      createTestAgent({ name, instructions: 'Answer in one short sentence.', maxTokens: 64 });
    testServer = await startTestA2AServer({
      agents: { main: agent('main'), second: agent('second') },
      cogitator,
    });
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  for (const transport of ['JSONRPC', 'HTTP+JSON'] as const) {
    describe(`over ${transport}`, () => {
      it('sends, streams and lists tasks with the 1.0 binding it chose', async () => {
        const client = new A2AClient(testServer.url, { transport });
        expect(await client.endpoint()).toMatchObject({
          protocolVersion: '1.0',
          transport,
          tenant: 'main',
        });

        const task = asTask(
          await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Hi.' }] })
        );
        expect(task.status.state).toBe('completed');
        expect(artifactText(task.artifacts![0]).trim().length).toBeGreaterThan(0);

        const events: A2AStreamEvent[] = [];
        for await (const event of client.sendMessageStream({
          role: 'user',
          parts: [{ kind: 'text', text: 'Name a fruit.' }],
        })) {
          events.push(event);
        }
        expect(events[0].kind).toBe('task');
        const last = events.at(-1)!;
        expect(last.kind === 'status-update' && last.final).toBe(true);

        const page = await client.listTasksPage({ pageSize: 1 });
        expect(page.tasks).toHaveLength(1);
        expect(page.totalSize).toBeGreaterThanOrEqual(2);
      });

      it('talks to a second agent through its tenant', async () => {
        const client = new A2AClient(testServer.url, { transport, agentName: 'second' });
        expect((await client.endpoint()).tenant).toBe('second');
        const task = asTask(
          await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Hello.' }] })
        );
        expect(task.status.state).toBe('completed');
        const main = new A2AClient(testServer.url, { transport });
        await expect(main.getTask(task.id)).rejects.toMatchObject({ code: -32001 });
      });
    });
  }

  it('works as a tool of another agent over 1.0', async () => {
    const tool = new A2AClient(testServer.url).asTool({ name: 'remote' });
    const result = await tool.execute(
      { task: 'Say ok.' },
      { agentId: 'caller', runId: 'run', signal: new AbortController().signal }
    );
    expect(result.success).toBe(true);
    expect(result.output.trim().length).toBeGreaterThan(0);
  });
});
