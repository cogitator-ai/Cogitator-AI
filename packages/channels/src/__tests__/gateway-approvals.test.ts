import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type { Channel, ChannelMessage, ToolApprovalRequest } from '@cogitator-ai/types';
import { Gateway } from '../gateway';
import type { GatewayFullConfig } from '../gateway';
import { createHookRegistry } from '../hooks';
import {
  DEFAULT_APPROVE_WORDS,
  DEFAULT_DENY_WORDS,
  formatApprovalPrompt,
  parseApprovalReply,
} from '../approvals';

const words = { approveWords: DEFAULT_APPROVE_WORDS, denyWords: DEFAULT_DENY_WORDS };

const pending: ToolApprovalRequest = {
  toolCallId: 'call_1',
  toolName: 'create_tool',
  arguments: { name: 'weather', code: 'export default () => 42' },
  description: 'Create a new tool at runtime',
};

const agent = {
  name: 'bot',
  id: 'a1',
  model: 'test/m',
  instructions: 'hi',
  tools: [],
  config: {},
} as never;

function pausedResult(output = '', approvals: ToolApprovalRequest[] = [pending]) {
  return { output, status: 'paused', pendingApprovals: approvals, usage: { totalTokens: 1 } };
}

function completedResult(output: string) {
  return { output, status: 'completed', usage: { totalTokens: 1 } };
}

function createMockChannel(): Channel & { trigger: (msg: ChannelMessage) => Promise<void> } {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  return {
    type: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((h) => {
      handler = h;
    }),
    sendText: vi.fn().mockResolvedValue('sent_1'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    trigger: async (msg: ChannelMessage) => {
      if (handler) await handler(msg);
    },
  };
}

function createMockCogitator() {
  return {
    run: vi.fn().mockResolvedValue(pausedResult('Let me build that tool.')),
    resume: vi.fn().mockResolvedValue(completedResult('Tool created.')),
  };
}

let nextId = 0;
function message(text: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  nextId++;
  return {
    id: `msg_${nextId}`,
    channelType: 'test',
    channelId: 'ch_1',
    userId: 'user_1',
    text,
    raw: {},
    ...overrides,
  };
}

function sentTexts(channel: Channel): string[] {
  return vi.mocked(channel.sendText).mock.calls.map((call) => call[1]);
}

describe('parseApprovalReply', () => {
  it('approves only on an approve word alone', () => {
    expect(parseApprovalReply('approve', words)).toEqual({ approved: true });
    expect(parseApprovalReply('  YES! ', words)).toEqual({ approved: true });
    expect(parseApprovalReply('yes please change the name', words)).toBeNull();
    expect(parseApprovalReply('yesterday', words)).toBeNull();
  });

  it('declines with the text after a deny word as the reason', () => {
    expect(parseApprovalReply('deny', words)).toEqual({ approved: false });
    expect(parseApprovalReply('No: too risky', words)).toEqual({
      approved: false,
      reason: 'too risky',
    });
    expect(parseApprovalReply('nobody asked', words)).toBeNull();
  });

  it('recognises the Russian replies', () => {
    expect(parseApprovalReply('Да', words)).toEqual({ approved: true });
    expect(parseApprovalReply('одобряю.', words)).toEqual({ approved: true });
    expect(parseApprovalReply('нет, слишком рискованно', words)).toEqual({
      approved: false,
      reason: 'слишком рискованно',
    });
    expect(parseApprovalReply('Отклоняю', words)).toEqual({ approved: false });
    expect(parseApprovalReply('давай', words)).toBeNull();
  });

  it('matches custom multi-word phrases', () => {
    const custom = { approveWords: ['go ahead'], denyWords: ['stop'] };
    expect(parseApprovalReply('Go ahead', custom)).toEqual({ approved: true });
    expect(parseApprovalReply('yes', custom)).toBeNull();
  });
});

describe('formatApprovalPrompt', () => {
  it('lists each call with compact, truncated arguments', () => {
    const long: ToolApprovalRequest = {
      toolCallId: 'call_2',
      toolName: 'write_file',
      arguments: { content: 'x'.repeat(1000) },
      description: 'Write a file',
    };
    const prompt = formatApprovalPrompt([pending, long], words);

    expect(prompt).toContain('1. **create_tool** — Create a new tool at runtime');
    expect(prompt).toContain('{"name":"weather","code":"export default () => 42"}');
    expect(prompt).toContain('2. **write_file**');
    expect(prompt).not.toContain('x'.repeat(400));
    expect(prompt).toContain('…');
    expect(prompt).toContain('"approve" or "yes"');
    expect(prompt).toContain('"deny" or "no"');
  });
});

describe('Gateway approvals', () => {
  let channel: ReturnType<typeof createMockChannel>;
  let cogitator: ReturnType<typeof createMockCogitator>;

  beforeEach(() => {
    channel = createMockChannel();
    cogitator = createMockCogitator();
  });

  async function startGateway(overrides: Partial<GatewayFullConfig> = {}) {
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: cogitator as never,
      ...overrides,
    });
    await gateway.start();
    return gateway;
  }

  it('sends the partial output and an approval prompt when a run pauses', async () => {
    const hooks = createHookRegistry();
    const requested = vi.fn();
    hooks.on('approval:requested', requested);
    await startGateway({ hooks });

    await channel.trigger(message('Make me a weather tool'));

    const texts = sentTexts(channel);
    expect(texts[0]).toBe('Let me build that tool.');
    expect(texts[1]).toContain('create_tool');
    expect(texts[1]).toContain('"name":"weather"');
    expect(texts[1]).toContain('Reply "approve"');
    expect(vi.mocked(channel.sendText).mock.calls[1][2]).not.toHaveProperty('replyTo');
    expect(requested).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'test:user_1', userId: 'user_1', approvals: [pending] })
    );
  });

  it('replies to the user message with the prompt when the paused run said nothing', async () => {
    cogitator.run.mockResolvedValueOnce(pausedResult(''));
    await startGateway();

    const msg = message('Make me a weather tool');
    await channel.trigger(msg);

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(channel.sendText).mock.calls[0][2]).toEqual(
      expect.objectContaining({ replyTo: msg.id })
    );
  });

  it('resumes with an approval and delivers the result', async () => {
    const hooks = createHookRegistry();
    const resolved = vi.fn();
    hooks.on('approval:resolved', resolved);
    await startGateway({ hooks });

    await channel.trigger(message('Make me a weather tool'));
    await channel.trigger(message('approve'));

    expect(cogitator.run).toHaveBeenCalledTimes(1);
    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'test:user_1',
      expect.objectContaining({ userId: 'user_1', defaultDecision: { approved: true } })
    );
    expect(sentTexts(channel).at(-1)).toBe('Tool created.');
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { approved: true },
        approvals: [pending],
        superseded: false,
      })
    );
  });

  it('resumes with a denial and its reason', async () => {
    await startGateway();

    await channel.trigger(message('Make me a weather tool'));
    await channel.trigger(message('deny too risky'));

    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'test:user_1',
      expect.objectContaining({ defaultDecision: { approved: false, reason: 'too risky' } })
    );
  });

  it('recognises Russian replies', async () => {
    await startGateway();

    cogitator.resume.mockResolvedValueOnce(pausedResult());
    await channel.trigger(message('Сделай инструмент погоды'));
    await channel.trigger(message('Да'));
    expect(cogitator.resume).toHaveBeenLastCalledWith(
      agent,
      'test:user_1',
      expect.objectContaining({ defaultDecision: { approved: true } })
    );

    await channel.trigger(message('нет, слишком рискованно'));
    expect(cogitator.resume).toHaveBeenCalledTimes(2);
    expect(cogitator.run).toHaveBeenCalledTimes(1);
    expect(cogitator.resume).toHaveBeenLastCalledWith(
      agent,
      'test:user_1',
      expect.objectContaining({
        defaultDecision: { approved: false, reason: 'слишком рискованно' },
      })
    );
  });

  it('prompts again when the resumed run pauses again', async () => {
    cogitator.resume.mockResolvedValueOnce(pausedResult('', [{ ...pending, toolCallId: 'c2' }]));
    await startGateway();

    await channel.trigger(message('Make me a weather tool'));
    await channel.trigger(message('yes'));
    await channel.trigger(message('yes'));

    expect(cogitator.resume).toHaveBeenCalledTimes(2);
    expect(sentTexts(channel).filter((text) => text.includes('create_tool'))).toHaveLength(2);
  });

  it('runs an unrelated message normally and forgets the pause', async () => {
    const hooks = createHookRegistry();
    const resolved = vi.fn();
    hooks.on('approval:resolved', resolved);
    await startGateway({ hooks });

    await channel.trigger(message('Make me a weather tool'));
    cogitator.run.mockResolvedValue(completedResult('Sure, forget the tool.'));
    await channel.trigger(message('Actually, what time is it?'));

    expect(cogitator.run).toHaveBeenLastCalledWith(
      agent,
      expect.objectContaining({ input: 'Actually, what time is it?', threadId: 'test:user_1' })
    );
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ superseded: true }));

    await channel.trigger(message('yes'));
    expect(cogitator.resume).not.toHaveBeenCalled();
    expect(cogitator.run).toHaveBeenLastCalledWith(
      agent,
      expect.objectContaining({ input: 'yes' })
    );
  });

  it('tries to resume on a thread it has not seen, then runs the message if nothing is paused', async () => {
    const onError = vi.fn();
    const hooks = createHookRegistry();
    const agentError = vi.fn();
    hooks.on('agent:error', agentError);
    cogitator.resume.mockRejectedValueOnce(
      new CogitatorError({ message: 'not paused', code: ErrorCode.RUN_NOT_PAUSED })
    );
    cogitator.run.mockResolvedValue(completedResult('Yes to what?'));
    await startGateway({ onError, hooks });

    await channel.trigger(message('yes'));

    expect(cogitator.resume).toHaveBeenCalledTimes(1);
    expect(cogitator.run).toHaveBeenCalledWith(agent, expect.objectContaining({ input: 'yes' }));
    expect(sentTexts(channel)).toEqual(['Yes to what?']);
    expect(onError).not.toHaveBeenCalled();
    expect(agentError).not.toHaveBeenCalled();
  });

  it('resumes a pause that predates the process', async () => {
    await startGateway();

    await channel.trigger(message('approve'));

    expect(cogitator.resume).toHaveBeenCalledTimes(1);
    expect(cogitator.run).not.toHaveBeenCalled();
    expect(sentTexts(channel)).toEqual(['Tool created.']);
  });

  it('tells another user in a shared thread that only the requester can answer', async () => {
    const onError = vi.fn();
    await startGateway({ onError, session: { threadKey: (msg) => msg.channelId } });

    await channel.trigger(message('Make me a weather tool'));
    cogitator.resume.mockRejectedValueOnce(
      new CogitatorError({ message: 'other user', code: ErrorCode.THREAD_ACCESS_DENIED })
    );
    await channel.trigger(message('approve', { userId: 'user_2' }));

    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'ch_1',
      expect.objectContaining({ userId: 'user_2' })
    );
    expect(cogitator.run).toHaveBeenCalledTimes(1);
    expect(sentTexts(channel).at(-1)).toBe(
      'Only the person who made this request can approve or deny it.'
    );
    expect(onError).not.toHaveBeenCalled();

    await channel.trigger(message('approve'));
    expect(cogitator.resume).toHaveBeenLastCalledWith(
      agent,
      'ch_1',
      expect.objectContaining({ userId: 'user_1' })
    );
  });

  it('uses the configured prompt, words and refusal message', async () => {
    const format = vi.fn(
      (approvals: readonly ToolApprovalRequest[]) => `Разрешить ${approvals[0].toolName}?`
    );
    await startGateway({
      approvals: { format, approveWords: ['ок'], denyWords: ['стоп'] },
    });

    await channel.trigger(message('Сделай инструмент'));
    expect(sentTexts(channel).at(-1)).toBe('Разрешить create_tool?');
    expect(format).toHaveBeenCalledWith([pending], {
      approveWords: ['ок'],
      denyWords: ['стоп'],
    });

    await channel.trigger(message('стоп хватит'));
    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'test:user_1',
      expect.objectContaining({ defaultDecision: { approved: false, reason: 'хватит' } })
    );
  });

  it('streams the resumed run', async () => {
    cogitator.resume.mockImplementation(
      async (_agent: unknown, _thread: string, options: { onToken?: (t: string) => void }) => {
        options.onToken?.('Tool ');
        options.onToken?.('created.');
        return completedResult('Tool created.');
      }
    );
    await startGateway({ stream: { flushInterval: 10_000, minChunkSize: 1 } });

    await channel.trigger(message('Make me a weather tool'));
    expect(sentTexts(channel).some((text) => text.includes('create_tool'))).toBe(true);

    await channel.trigger(message('approve'));
    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'test:user_1',
      expect.objectContaining({ stream: true, defaultDecision: { approved: true } })
    );
    const delivered = [
      ...sentTexts(channel),
      ...vi.mocked(channel.editText).mock.calls.map((call) => call[2]),
    ];
    expect(delivered).toContain('Tool created.');
  });
});
