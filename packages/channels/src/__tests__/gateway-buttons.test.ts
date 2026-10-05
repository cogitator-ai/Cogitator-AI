import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Channel,
  ChannelAction,
  ChannelMessage,
  ChannelStop,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import { Gateway } from '../gateway';
import type { GatewayFullConfig } from '../gateway';
import { createHookRegistry } from '../hooks';
import { APPROVE_ACTION, DENY_ACTION } from '../approvals';

const pending: ToolApprovalRequest = {
  toolCallId: 'call_1',
  toolName: 'publish',
  arguments: { edition: 'noon' },
  description: 'Publish the edition',
};

const agent = {
  name: 'bot',
  id: 'a1',
  model: 'test/m',
  instructions: 'hi',
  tools: [],
  config: {},
} as never;

type ButtonChannel = Channel & {
  trigger(msg: ChannelMessage): Promise<void>;
  press(action: Partial<ChannelAction> & { data: string }): Promise<void>;
  stopDraft(stop: ChannelStop): void;
};

function createChannel(overrides: Partial<Channel> = {}): ButtonChannel {
  let onMessage: ((msg: ChannelMessage) => Promise<void>) | null = null;
  let onAction: ((action: ChannelAction) => Promise<void>) | null = null;
  let onStop: ((stop: ChannelStop) => void) | null = null;
  return {
    type: 'telegram',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((h) => {
      onMessage = h;
    }),
    onAction: vi.fn((h) => {
      onAction = h;
    }),
    onStop: vi.fn((h) => {
      onStop = h;
    }),
    sendText: vi.fn().mockResolvedValue('prompt_1'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    answerAction: vi.fn().mockResolvedValue(undefined),
    editButtons: vi.fn().mockResolvedValue(undefined),
    ...overrides,
    trigger: async (msg) => {
      await onMessage?.(msg);
    },
    press: async (action) => {
      await onAction?.({
        id: 'press_1',
        channelType: 'telegram',
        channelId: '42',
        userId: '42',
        messageId: 'prompt_1',
        raw: {},
        ...action,
      });
    },
    stopDraft: (stop) => {
      onStop?.(stop);
    },
  };
}

let nextId = 0;
function message(text: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  nextId++;
  return {
    id: `msg_${nextId}`,
    channelType: 'telegram',
    channelId: '42',
    userId: '42',
    text,
    raw: {},
    ...overrides,
  };
}

function paused(output = 'Ready to publish.') {
  return { output, status: 'paused', pendingApprovals: [pending], usage: { totalTokens: 1 } };
}

function completed(output: string) {
  return { output, status: 'completed', usage: { totalTokens: 1 } };
}

describe('Gateway buttons', () => {
  let channel: ButtonChannel;
  let cogitator: { run: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    channel = createChannel();
    cogitator = {
      run: vi.fn().mockResolvedValue(paused()),
      resume: vi.fn().mockResolvedValue(completed('Published.')),
    };
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

  it('puts Approve and Deny buttons under the approval prompt', async () => {
    await startGateway();
    await channel.trigger(message('Publish the noon edition'));

    const prompt = vi.mocked(channel.sendText).mock.calls.at(-1)!;
    expect(prompt[1]).toContain('publish');
    expect(prompt[2]?.buttons).toEqual([
      [
        { text: 'Approve', data: APPROVE_ACTION, style: 'success' },
        { text: 'Deny', data: DENY_ACTION, style: 'danger' },
      ],
    ]);
  });

  it('leaves the buttons out when they are turned off', async () => {
    await startGateway({ approvals: { buttons: false } });
    await channel.trigger(message('Publish the noon edition'));
    expect(vi.mocked(channel.sendText).mock.calls.at(-1)![2]).not.toHaveProperty('buttons');
  });

  it('resumes the paused run when Approve is pressed, and shows the decision', async () => {
    await startGateway({ approvals: { buttonLabels: { approved: 'Going to press' } } });
    await channel.trigger(message('Publish the noon edition'));

    await channel.press({ data: APPROVE_ACTION });

    expect(channel.answerAction).toHaveBeenCalledWith('press_1', undefined);
    expect(channel.editButtons).toHaveBeenCalledWith('42', 'prompt_1', [
      [{ text: 'Going to press', disabled: true, style: 'success' }],
    ]);
    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'telegram:42',
      expect.objectContaining({ defaultDecision: { approved: true } })
    );
    expect(vi.mocked(channel.sendText).mock.calls.at(-1)![1]).toBe('Published.');
  });

  it('declines when Deny is pressed', async () => {
    await startGateway();
    await channel.trigger(message('Publish the noon edition'));
    await channel.press({ data: DENY_ACTION });
    expect(cogitator.resume).toHaveBeenCalledWith(
      agent,
      'telegram:42',
      expect.objectContaining({ defaultDecision: { approved: false } })
    );
  });

  it('refuses a press from someone else in a shared thread', async () => {
    await startGateway({ session: { threadKey: (msg) => msg.channelId } });
    await channel.trigger(message('Publish the noon edition'));

    await channel.press({ data: APPROVE_ACTION, userId: '7' });

    expect(channel.answerAction).toHaveBeenLastCalledWith('press_1', {
      text: 'Only the person who made this request can approve or deny it.',
      alert: true,
    });
    expect(channel.editButtons).not.toHaveBeenCalled();
    expect(cogitator.resume).not.toHaveBeenCalled();
  });

  it('refuses a stranger with a thread of their own, who never wrote to the bot', async () => {
    await startGateway();
    await channel.trigger(message('Publish the noon edition'));

    await channel.press({ data: APPROVE_ACTION, userId: '7', channelId: '42' });

    expect(channel.answerAction).toHaveBeenLastCalledWith(
      'press_1',
      expect.objectContaining({ alert: true })
    );
    expect(channel.editButtons).not.toHaveBeenCalled();
    expect(cogitator.run).toHaveBeenCalledTimes(1);
    expect(cogitator.resume).not.toHaveBeenCalled();
  });

  it('retires the buttons once the request is answered, and refuses later presses', async () => {
    await startGateway();
    await channel.trigger(message('Publish the noon edition'));

    await channel.trigger(message('approve'));
    expect(channel.editButtons).toHaveBeenCalledWith('42', 'prompt_1', [
      [{ text: 'Approved', disabled: true, style: 'success' }],
    ]);

    await channel.press({ data: DENY_ACTION, id: 'late' });
    expect(channel.answerAction).toHaveBeenLastCalledWith('late', {
      text: 'This request is no longer waiting. Reply "approve" or "deny" if it is still paused.',
      alert: true,
    });
    expect(cogitator.resume).toHaveBeenCalledTimes(1);
  });

  it('takes the buttons away when the user moves on without answering', async () => {
    await startGateway();
    await channel.trigger(message('Publish the noon edition'));
    cogitator.run.mockResolvedValueOnce(completed('Sure.'));
    await channel.trigger(message('Actually, tell me a joke'));
    expect(channel.editButtons).toHaveBeenCalledWith('42', 'prompt_1', null);
  });

  it('hands every other press to the action:received hook and answers it once', async () => {
    const hooks = createHookRegistry();
    const seen: string[] = [];
    hooks.on('action:received', async ({ action, answer }) => {
      seen.push(action.data);
      if (action.data === 'loud') await answer({ text: 'Heard you' });
    });
    await startGateway({ hooks });

    await channel.press({ data: 'quiet', id: 'q' });
    await channel.press({ data: 'loud', id: 'l' });

    expect(seen).toEqual(['quiet', 'loud']);
    expect(vi.mocked(channel.answerAction!).mock.calls).toEqual([
      ['q', undefined],
      ['l', { text: 'Heard you' }],
    ]);
  });

  it('stops a streamed run from the draft button and keeps what it wrote', async () => {
    channel = createChannel({ sendDraft: vi.fn().mockResolvedValue(undefined) });
    const onError = vi.fn();
    const hooks = createHookRegistry();
    const finished = vi.fn();
    hooks.on('stream:finished', finished);
    cogitator.run.mockImplementation(
      (_agent: unknown, options: { onToken?: (t: string) => void; signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('The first half of the answer');
          setTimeout(() => {
            const draft = vi.mocked(channel.sendDraft!).mock.calls[0];
            channel.stopDraft({
              channelType: 'telegram',
              channelId: '42',
              draftId: draft?.[1] ?? -1,
            });
          }, 20);
          options.signal?.addEventListener('abort', () => reject(new Error('Run aborted')));
        })
    );
    await startGateway({ onError, hooks, stream: { flushInterval: 5, minChunkSize: 1 } });

    await channel.trigger(message('Write me an essay'));

    expect(vi.mocked(channel.sendDraft!).mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ canStop: true, format: 'markdown' })
    );
    expect(vi.mocked(channel.sendText).mock.calls.at(-1)![1]).toBe('The first half of the answer');
    expect(onError).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('sends Markdown as written to a channel that renders it, into the message topic', async () => {
    channel = createChannel({ nativeMarkdown: true, maxMessageChars: 32768 });
    cogitator.run.mockResolvedValue(completed('## Heading\n\n**bold**'));
    await startGateway();

    await channel.trigger(message('Format it', { topicId: '9' }));

    expect(channel.sendTyping).toHaveBeenCalledWith('42', { topicId: '9' });
    expect(channel.sendText).toHaveBeenCalledWith('42', '## Heading\n\n**bold**', {
      replyTo: expect.any(String),
      topicId: '9',
      format: 'markdown',
    });
  });

  it('adapts Markdown for a channel that does not render it', async () => {
    cogitator.run.mockResolvedValue(completed('## Heading'));
    await startGateway();
    await channel.trigger(message('Format it'));
    expect(vi.mocked(channel.sendText).mock.calls.at(-1)![1]).toBe('*Heading*');
  });
});
