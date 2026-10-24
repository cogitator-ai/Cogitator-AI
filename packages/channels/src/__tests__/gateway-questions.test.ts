import { describe, it, expect, vi } from 'vitest';
import type { Channel, ChannelMessage, RunInterrupt, RunOptions } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { BUDGET_RESPONSE_SCHEMA, budgetMessage } from '@cogitator-ai/core';
import { z } from 'zod';
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
        new CogitatorError({ message: 'not a region', code: ErrorCode.INTERRUPT_ANSWER_INVALID })
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

  const yesNo: RunInterrupt = {
    ...question,
    id: 'b1#0',
    message: 'Go ahead?',
    responseSchema: { type: 'boolean' },
  };
  const pausedOn = (asked: RunInterrupt) => ({ ...pausedOnQuestion, interrupts: [asked] });

  it('tells what an answer looks like and reads yes as true', async () => {
    const channel = createChannel();
    const run = vi.fn(async () => pausedOn(yesNo));
    const resume = vi.fn(async (_agent: unknown, _thread: string, _opts: RunOptions) => ({
      output: 'Done.',
    }));
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume } as never,
    });
    await gateway.start();
    await channel.trigger(message('Deploy', 'm1'));
    await gateway.idle();
    expect(channel.sendText.mock.calls.map((call) => call[1])).toContain('Go ahead? (yes or no)');
    await channel.trigger(message('Yes', 'm2'));
    await gateway.idle();
    expect(resume.mock.calls[0]?.[2]).toMatchObject({ responses: { 'b1#0': true } });
    await gateway.stop();
  });

  it('cancels the question with a cancel word, and after too many answers that do not fit', async () => {
    for (const replies of [['cancel'], ['maybe', 'perhaps', 'dunno']]) {
      const channel = createChannel();
      const run = vi.fn(async () => pausedOn(yesNo));
      const resume = vi.fn();
      const cancelPause = vi.fn(async () => true);
      const gateway = new Gateway({
        agent,
        channels: [channel],
        cogitator: { run, resume, cancelPause } as never,
      });
      await gateway.start();
      await channel.trigger(message('Deploy', 'm1'));
      await gateway.idle();
      for (const [index, reply] of replies.entries()) {
        await channel.trigger(message(reply, `r${index}`));
        await gateway.idle();
      }
      const said = channel.sendText.mock.calls.map((call) => String(call[1]));
      expect(resume).not.toHaveBeenCalled();
      expect(cancelPause).toHaveBeenCalledTimes(1);
      expect(said.at(-1)).toMatch(replies.length === 1 ? /^Cancelled/ : /was cancelled/);
      expect(said.some((text) => text.includes('#0'))).toBe(false);
      if (replies.length > 1)
        expect(said).toContain(
          'That does not answer "Go ahead?": the answer should be yes or no. Reply "cancel" to skip it.'
        );
      await gateway.stop();
    }
  });

  it('ends the pause when the question expired', async () => {
    const channel = createChannel();
    const run = vi.fn(async () => pausedOnQuestion);
    const resume = vi.fn(async () => {
      throw new CogitatorError({ message: 'expired', code: ErrorCode.INTERRUPT_EXPIRED });
    });
    const cancelPause = vi.fn(async () => true);
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume, cancelPause } as never,
    });
    await gateway.start();
    await channel.trigger(message('Deploy', 'm1'));
    await gateway.idle();
    await channel.trigger(message('eu', 'm2'));
    await gateway.idle();
    expect(cancelPause).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'the question expired' })
    );
    expect(String(channel.sendText.mock.calls.at(-1)?.[1])).toContain('expired');
    await channel.trigger(message('Deploy again', 'm3'));
    await gateway.idle();
    expect(run).toHaveBeenCalledTimes(2);
    await gateway.stop();
  });

  it('picks the question up from the runtime after a restart', async () => {
    const channel = createChannel();
    const run = vi.fn();
    const resume = vi.fn(async (_agent: unknown, _thread: string, _opts: RunOptions) => ({
      output: 'Deployed to eu.',
    }));
    const pausedRun = vi.fn(async () => ({ runId: 'r1', userId: 'u1', interrupts: [question] }));
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume, pausedRun } as never,
    });
    await gateway.start();
    await channel.trigger(message('eu', 'm1'));
    await gateway.idle();
    expect(run).not.toHaveBeenCalled();
    expect(resume.mock.calls[0]?.[2]).toMatchObject({ responses: { 'q1#0': 'eu' } });
    await gateway.stop();
  });

  const planQuestion: RunInterrupt = {
    id: 'p1#0',
    kind: 'plan',
    reason: 'plan_approval',
    message: 'Approve the plan so the agent can carry it out',
    responseSchema: (({ $schema: _schema, ...schema }) => schema)(
      z.toJSONSchema(
        z.object({
          approved: z.boolean(),
          mode: z.enum(['default', 'acceptEdits', 'dontAsk']).optional(),
          feedback: z.string().optional(),
        }),
        { io: 'input' }
      )
    ),
    toolCallId: 'p1',
    toolName: 'exit_plan_mode',
    details: { plan: '1. Read the config\n2. Fix the port' },
  };

  const usage = { scope: 'session', metric: 'cost', used: 1.2, limit: 1 } as const;
  const budgetQuestion: RunInterrupt = {
    id: 'budget:session.cost',
    kind: 'budget',
    reason: 'budget_exceeded',
    message: budgetMessage(usage),
    responseSchema: BUDGET_RESPONSE_SCHEMA,
    details: { ...usage },
  };

  it.each([
    [planQuestion, 'yes', { approved: true }],
    [planQuestion, 'нет', { approved: false }],
    [budgetQuestion, 'stop', { action: 'stop' }],
    [budgetQuestion, 'Continue', { action: 'continue' }],
    [budgetQuestion, '{"action":"continue","limit":5}', { action: 'continue', limit: 5 }],
  ])('answers a %s question with "%s"', async (asked, reply, answer) => {
    const channel = createChannel();
    const run = vi.fn(async () => ({ ...pausedOnQuestion, interrupts: [asked] }));
    const resume = vi.fn(async (_agent: unknown, _thread: string, _opts: RunOptions) => ({
      output: 'Done.',
    }));
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run, resume } as never,
    });
    await gateway.start();
    await channel.trigger(message('Fix the port', 'm1'));
    await gateway.idle();
    await channel.trigger(message(reply, 'm2'));
    await gateway.idle();
    expect(resume.mock.calls[0]?.[2]).toMatchObject({ responses: { [asked.id]: answer } });
    await gateway.stop();
  });

  it('shows the plan it asks to approve, and the usage of a budget it reached', async () => {
    for (const asked of [planQuestion, budgetQuestion]) {
      const channel = createChannel();
      const run = vi.fn(async () => ({ ...pausedOnQuestion, interrupts: [asked] }));
      const gateway = new Gateway({
        agent,
        channels: [channel],
        cogitator: { run, resume: vi.fn() } as never,
      });
      await gateway.start();
      await channel.trigger(message('Fix the port', 'm1'));
      await gateway.idle();
      const prompt = String(channel.sendText.mock.calls.at(-1)?.[1]);
      if (asked.kind === 'plan') {
        expect(prompt).toContain('1. Read the config\n2. Fix the port');
        expect(prompt).toContain('Approve the plan so the agent can carry it out (yes or no)');
      } else {
        expect(prompt).toContain('$1.2000 of $1.0000');
        expect(prompt).toContain('(one of: continue, stop)');
      }
      await gateway.stop();
    }
  });
});
