import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  isProviderSafeToolName,
  normalizeToolName,
  tool,
  toolContent,
  type RunResult,
} from '@cogitator-ai/core';
import type { ToolResult } from '@cogitator-ai/types';
import { startFakeOllama, type FakeMessage, type FakeOllama } from '../../helpers/fake-ollama';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const MODEL = 'qwen3.5:4b';

let fake: FakeOllama | undefined;
let cogitator: Cogitator | undefined;

afterEach(async () => {
  await cogitator?.close();
  await fake?.close();
  cogitator = undefined;
  fake = undefined;
});

function callsToolOnce(name: string, args: Record<string, unknown> = {}) {
  return (messages: FakeMessage[]) =>
    messages.some((m) => m.role === 'tool')
      ? { content: 'Done.' }
      : { toolCalls: [{ name, arguments: args }] };
}

async function fakeCogitator(
  reply: Parameters<typeof startFakeOllama>[0],
  extra: Partial<ConstructorParameters<typeof Cogitator>[0]> = {}
): Promise<Cogitator> {
  fake = await startFakeOllama(reply, [MODEL]);
  cogitator = new Cogitator({
    llm: { defaultModel: `ollama/${MODEL}`, providers: { ollama: { baseUrl: fake.url } } },
    ...extra,
  });
  return cogitator;
}

const agentWith = (...tools: ReturnType<typeof tool>[]) =>
  new Agent({ name: 'worker', model: `ollama/${MODEL}`, instructions: 'Use your tools.', tools });

const toolMessageSent = () =>
  fake!.requests[1]!.messages.find((message) => message.role === 'tool')!.content;

describe('Core: tool contract', () => {
  it('refuses a tool name a provider would reject, and suggests one that fits', () => {
    expect(() =>
      tool({
        name: 'weather.get',
        description: 'Weather',
        parameters: z.object({}),
        execute: async () => 'sunny',
      })
    ).toThrow(/Invalid tool name "weather.get".*For example "weather_get"/);
    expect(isProviderSafeToolName(normalizeToolName('Research Agent v2'))).toBe(true);
  });

  it('sends json and resource parts to the model as text over the Ollama API', async () => {
    const cog = await fakeCogitator(callsToolOnce('read_order'));
    const readOrder = tool({
      name: 'read_order',
      description: 'Read an order',
      parameters: z.object({}),
      execute: async () =>
        toolContent(
          { type: 'json', value: { id: 'A-17', carrier: 'DHL' } },
          {
            type: 'resource',
            uri: 'file:///orders/A-17.md',
            mediaType: 'text/markdown',
            text: 'Fragile',
          }
        ),
    });

    const results: ToolResult[] = [];
    await cog.run(agentWith(readOrder), {
      input: 'Read the order',
      onToolResult: (result) => results.push(result),
    });

    expect(toolMessageSent()).toBe(
      '{"id":"A-17","carrier":"DHL"}\n[resource file:///orders/A-17.md (text/markdown)]\nFragile'
    );
    expect(results[0]?.result).toEqual({
      type: 'tool-content',
      content: [
        { type: 'json', value: { id: 'A-17', carrier: 'DHL' } },
        {
          type: 'resource',
          uri: 'file:///orders/A-17.md',
          mediaType: 'text/markdown',
          text: 'Fragile',
        },
      ],
    });
  });

  it('cuts a long result for the model while the application gets all of it', async () => {
    const cog = await fakeCogitator(callsToolOnce('dump_log'), {
      limits: { maxToolResultLength: 500 },
    });
    const log = `${'line\n'.repeat(2000)}FINAL STATUS: ok`;
    const dumpLog = tool({
      name: 'dump_log',
      description: 'Dump the log',
      parameters: z.object({}),
      execute: async () => log,
    });

    const results: ToolResult[] = [];
    await cog.run(agentWith(dumpLog), {
      input: 'Show the log',
      onToolResult: (result) => results.push(result),
    });

    const sent = toolMessageSent();
    expect(sent.length).toBeLessThan(600);
    expect(sent).toContain('characters of this tool result were left out');
    expect(sent).toContain('FINAL STATUS: ok');
    expect(results[0]?.result).toBe(log);
  });

  it('stops a sandboxed command when the run is cancelled', async () => {
    const base = join(tmpdir(), `cogitator-abort-${process.pid}-${Date.now()}`);
    const started = `${base}.started`;
    const finished = `${base}.finished`;
    const cog = await fakeCogitator(
      callsToolOnce('shell', { command: `touch ${started} && sleep 3 && touch ${finished}` }),
      { sandbox: { docker: { socketPath: join(tmpdir(), 'no-docker-here.sock') } } }
    );
    const shell = tool({
      name: 'shell',
      description: 'Run a shell command',
      parameters: z.object({ command: z.string() }),
      sandbox: { type: 'docker', image: 'alpine:3.19' },
      execute: async () => ({ unreachable: true }),
    });

    try {
      const controller = new AbortController();
      const begin = Date.now();
      const run = cog.run(agentWith(shell), {
        input: 'Run it',
        signal: controller.signal,
        onToolCall: () => setTimeout(() => controller.abort(new Error('user cancelled')), 500),
      });

      await expect(run).rejects.toThrow();
      expect(Date.now() - begin).toBeLessThan(2500);
      expect(existsSync(started)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 4000));
      expect(existsSync(finished)).toBe(false);
    } finally {
      rmSync(started, { force: true });
      rmSync(finished, { force: true });
    }
  }, 15_000);
});

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

describeOllama('Core: tool contract with a real model', () => {
  it('answers from a json part of a tool result', async () => {
    const real = createTestCogitator();
    const lookupOrder = tool({
      name: 'lookup_order',
      description: 'Look up an order by its id and return its details',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) =>
        toolContent(
          { type: 'text', text: `Order ${id}` },
          { type: 'json', value: { id, status: 'shipped', carrier: 'DHL' } }
        ),
    });
    const agent = createTestAgent({
      instructions: 'You answer questions about orders. Always call lookup_order first.',
      tools: [lookupOrder],
    });

    let result: RunResult | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      result = await real.run(agent, {
        input: 'Which carrier ships order A-17? Call lookup_order with id "A-17".',
      });
      if (result.toolCalls.length > 0 && /DHL/i.test(result.output)) break;
    }
    await real.close();

    expect(result!.toolCalls.some((call) => call.name === 'lookup_order')).toBe(true);
    expect(result!.output).toMatch(/DHL/i);
  }, 120_000);
});
