import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { HookRunRecord, HooksConfig, HttpHookHandler, Message } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

interface Received {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let url: string;
const received: Received[] = [];
let answer: { status: number; body: string; location?: string } = { status: 200, body: '' };

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      });
      response.writeHead(answer.status, {
        'content-type': 'application/json',
        ...(answer.location && { location: answer.location }),
      });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const noted = vi.fn(async ({ text }: { text: string }) => `noted ${text}`);
const note = tool({
  name: 'note',
  description: 'Note something',
  parameters: z.object({ text: z.string() }),
  execute: noted,
});

beforeEach(() => {
  received.length = 0;
  noted.mockClear();
  answer = { status: 200, body: '' };
});

const noteTurn: MockChatResponse = {
  content: '',
  toolCalls: [{ id: 'c1', name: 'note', arguments: { text: 'a' } }],
  finishReason: 'tool_calls',
};

async function runWith(
  hooks: HooksConfig
): Promise<{ messages: readonly Message[]; runs: HookRunRecord[] }> {
  const runs: HookRunRecord[] = [];
  const backend = new MockLLMBackend().setResponses([noteTurn, { content: 'done' }]);
  const cog = new Cogitator({
    llm: { backends: { mock: backend }, retry: false },
    hooks: { ...hooks, onHookRun: (run) => runs.push(run) },
  });
  const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'Note.', tools: [note] });
  const result = await cog.run(agent, { input: 'go' });
  await cog.close();
  return { messages: result.messages, runs };
}

const http = (path: string, extra: Partial<HttpHookHandler> = {}): HttpHookHandler => ({
  type: 'http',
  url: `${url}${path}`,
  ...extra,
});

const toolText = (messages: readonly Message[]) =>
  String(messages.find((message) => message.role === 'tool')?.content);

describe('HTTP hooks', () => {
  it('posts the event JSON and applies the decision it answers with', async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'the service said no',
        },
      }),
    };
    const { messages } = await runWith({ hooks: { PreToolUse: [{ hooks: [http('/pre')] }] } });
    expect(noted).not.toHaveBeenCalled();
    expect(toolText(messages)).toContain('the service said no');
    expect(received[0]).toMatchObject({
      path: '/pre',
      body: { hook_event_name: 'PreToolUse', tool_name: 'note', tool_input: { text: 'a' } },
    });
    expect(received[0]?.headers['content-type']).toBe('application/json');
  });

  it('puts only allowed environment variables into headers', async () => {
    vi.stubEnv('HOOK_TOKEN', 'abc');
    vi.stubEnv('HOOK_SECRET', 'zzz');
    await runWith({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              http('/headers', {
                headers: { authorization: 'Bearer $HOOK_TOKEN:${HOOK_SECRET}:' },
                allowedEnvVars: ['HOOK_TOKEN'],
              }),
            ],
          },
        ],
      },
    });
    vi.unstubAllEnvs();
    expect(received[0]?.headers.authorization).toBe('Bearer abc::');
  });

  it('skips a URL outside allowedHttpHookUrls', async () => {
    const { runs } = await runWith({
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
      hooks: { PreToolUse: [{ hooks: [http('/blocked')] }] },
    });
    expect(received).toHaveLength(0);
    expect(runs[0]?.outcome).toBe('skipped');
    expect(noted).toHaveBeenCalledOnce();
  });

  it('lets the call go on after a failed request, unless onFailure blocks', async () => {
    answer = { status: 500, body: 'oops' };
    const loose = await runWith({ hooks: { PreToolUse: [{ hooks: [http('/fail')] }] } });
    expect(loose.runs[0]).toMatchObject({ outcome: 'error' });
    expect(noted).toHaveBeenCalledOnce();

    noted.mockClear();
    const strict = await runWith({
      hooks: { PreToolUse: [{ hooks: [http('/fail', { onFailure: 'block' })] }] },
    });
    expect(noted).not.toHaveBeenCalled();
    expect(toolText(strict.messages)).toContain('Permission denied');
  });

  it('does not follow a redirect', async () => {
    answer = { status: 302, body: '', location: `${url}/elsewhere` };
    const { runs } = await runWith({ hooks: { PreToolUse: [{ hooks: [http('/moved')] }] } });
    expect(received.map((entry) => entry.path)).toEqual(['/moved']);
    expect(runs[0]?.outcome).toBe('error');
    expect(noted).toHaveBeenCalledOnce();
  });
});
