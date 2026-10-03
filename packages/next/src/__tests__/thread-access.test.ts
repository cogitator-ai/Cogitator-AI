import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type { ChatStreamChunk, LLMBackend } from '@cogitator-ai/types';
import { createAgentHandler } from '../handlers/agent.js';
import { createChatHandler } from '../handlers/chat.js';

const chat = vi.fn(async () => ({
  id: 'r',
  content: 'ok',
  finishReason: 'stop' as const,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
}));

const backend: LLMBackend = {
  provider: 'openai',
  chat,
  chatStream: async function* (): AsyncGenerator<ChatStreamChunk> {
    yield { id: 's', delta: { content: 'ok' }, finishReason: 'stop' };
  },
};

const agent = new Agent({ name: 'support', model: 'mock/m', instructions: 'Help.' });

const runtimes: Cogitator[] = [];

function cogitator(): Cogitator {
  const cog = new Cogitator({
    llm: { backends: { mock: backend } },
    memory: { adapter: 'memory' },
  });
  runtimes.push(cog);
  return cog;
}

const callerFromHeader = async (req: Request) => {
  const userId = req.headers.get('x-user');
  return userId ? { userId } : undefined;
};

function request(path: string, userId: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': userId },
    body: JSON.stringify(body),
  });
}

async function streamEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((cog) => cog.close()));
  chat.mockClear();
});

describe('agent handler with several users', () => {
  it("answers 403 THREAD_ACCESS_DENIED for another user's thread", async () => {
    const handler = createAgentHandler(cogitator(), agent, { beforeRun: callerFromHeader });

    const own = await handler(request('/api/agent', 'ada', { input: 'hi', threadId: 't-ada' }));
    expect(own.status).toBe(200);
    expect(chat).toHaveBeenCalledTimes(1);

    const foreign = await handler(
      request('/api/agent', 'grace', { input: 'hi', threadId: 't-ada' })
    );

    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({
      error: 'Thread t-ada belongs to another user',
      code: 'THREAD_ACCESS_DENIED',
    });
    expect(chat).toHaveBeenCalledTimes(1);

    const again = await handler(request('/api/agent', 'ada', { input: 'more', threadId: 't-ada' }));
    expect(again.status).toBe(200);
  });

  it('passes the userId from beforeRun to the run', async () => {
    const cog = cogitator();
    const run = vi.spyOn(cog, 'run');
    const handler = createAgentHandler(cog, agent, { beforeRun: callerFromHeader });

    await handler(request('/api/agent', 'ada', { input: 'hi', threadId: 't-1' }));

    expect(run.mock.calls[0]?.[1]).toMatchObject({ threadId: 't-1', userId: 'ada' });
  });

  it('answers any CogitatorError with its status and code', async () => {
    const cog = cogitator();
    vi.spyOn(cog, 'run').mockRejectedValue(
      new CogitatorError({ message: 'Slow down', code: ErrorCode.LLM_RATE_LIMITED })
    );
    const handler = createAgentHandler(cog, agent);

    const res = await handler(request('/api/agent', 'ada', { input: 'hi' }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Slow down', code: 'LLM_RATE_LIMITED' });
  });

  it('answers other errors with 500', async () => {
    const cog = cogitator();
    vi.spyOn(cog, 'run').mockRejectedValue(new Error('boom'));
    const handler = createAgentHandler(cog, agent);

    const res = await handler(request('/api/agent', 'ada', { input: 'hi' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
  });
});

describe('chat handler with several users', () => {
  it("ends the stream with THREAD_ACCESS_DENIED for another user's thread", async () => {
    const handler = createChatHandler(cogitator(), agent, { beforeRun: callerFromHeader });
    const body = (content: string) => ({
      messages: [{ role: 'user', content }],
      threadId: 't-ada',
    });

    const own = await streamEvents(await handler(request('/api/chat', 'ada', body('hi'))));
    expect(own.at(-1)).toMatchObject({ type: 'finish', threadId: 't-ada' });

    const foreign = await streamEvents(await handler(request('/api/chat', 'grace', body('hi'))));

    expect(foreign.map((event) => event.type)).toEqual(['start', 'error']);
    expect(foreign.at(-1)).toEqual({
      type: 'error',
      message: 'Thread t-ada belongs to another user',
      code: 'THREAD_ACCESS_DENIED',
    });
  });
});
