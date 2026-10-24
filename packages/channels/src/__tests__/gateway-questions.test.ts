import { describe, it, expect, vi } from 'vitest';
import type { Channel, ChannelMessage, RunInterrupt, RunOptions } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { Gateway } from '../gateway';

function createChannel() {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  const channel = {
    type: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((h: (msg: ChannelMessage) => Promise<void>) => {
      handler = h;
    }),
    sendText: vi.fn().mockResolvedValue('sent'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    trigger: (msg: ChannelMessage) => handler?.(msg) ?? Promise.resolve(),
  };
  return channel satisfies Channel & { trigger: unknown };
}

const agent = {
  id: 'a1',
  name: 'bot',
  model: 'ollama/test',
  instructions: '',
  tools: [],
  config: { name: 'bot', model: 'ollama/test', instructions: '' },
} as never;

const message = (text: string, id: string, userId = 'u1'): ChannelMessage => ({
  id,
  channelType: 'test',
  channelId: 'c1',
  userId,
  text,
  raw: {},
});

const question: RunInterrupt = {
  id: 'q1#0',
  kind: 'input',
  reason: 'pick_region',
  message: 'Which region should I deploy to?',
  responseSchema: { type: 'string' },
  toolCallId: 'q1',
  toolName: 'deploy',
};

const pausedOnQuestion = {
  output: 'Before I deploy:',
  status: 'paused',
  threadId: 't',
  runId: 'r1',
  pendingApprovals: [],
  interrupts: [question],
};

describe('Gateway and questions of tools', () => {
  it('asks the question in the chat and resumes with the next message as its answer', async () => {
    const channel = createChannel();
    const run = vi.fn(async () => pausedOnQuestion);
    const resume = vi.fn(async (_agent: unknown, _thread: string, _opts: RunOptions) => ({
      output: 'Deployed to eu.',
    }));
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume } as never,
    });
    await gateway.start();
    await channel.trigger(message('Deploy the api', 'm1'));
    await gateway.idle();
    expect(channel.sendText.mock.calls.map((call) => call[1])).toContain(question.message);

    await channel.trigger(message('eu', 'm2'));
    await gateway.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[2]).toMatchObject({ responses: { 'q1#0': 'eu' } });
    expect(channel.sendText.mock.calls.at(-1)?.[1]).toBe('Deployed to eu.');
    await gateway.stop();
  });

  it('tells the user an answer the run refused and keeps the question waiting', async () => {
    const channel = createChannel();
    const run = vi.fn(async () => pausedOnQuestion);
    const resume = vi
      .fn()
      .mockRejectedValueOnce(
        new CogitatorError({ message: 'not a region', code: ErrorCode.VALIDATION_ERROR })
      )
      .mockResolvedValueOnce({ output: 'Deployed to us.' });
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume } as never,
    });
    await gateway.start();
    await channel.trigger(message('Deploy the api', 'm1'));
    await gateway.idle();
    await channel.trigger(message('mars', 'm2'));
    await gateway.idle();
    expect(channel.sendText.mock.calls.at(-1)?.[1]).toContain('That does not answer');

    await channel.trigger(message('us', 'm3'));
    await gateway.idle();
    expect(resume).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(channel.sendText.mock.calls.at(-1)?.[1]).toBe('Deployed to us.');
    await gateway.stop();
  });

  it('runs a message of another user as a new turn', async () => {
    const channel = createChannel();
    const run = vi.fn(async () => pausedOnQuestion);
    const resume = vi.fn();
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume } as never,
    });
    await gateway.start();
    await channel.trigger(message('Deploy the api', 'm1'));
    await gateway.idle();
    await channel.trigger(message('hello', 'm2', 'u2'));
    await gateway.idle();
    expect(resume).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
    await gateway.stop();
  });
});
