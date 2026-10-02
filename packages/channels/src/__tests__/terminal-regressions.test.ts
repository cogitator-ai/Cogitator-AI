import { describe, it, expect, vi, afterEach } from 'vitest';
import { TerminalChannel } from '../channels/terminal';

interface Internals {
  handleInput(s: string): Promise<void>;
  showPrompt(): void;
  rl: {
    question: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } | null;
  questionPending: boolean;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function withFakeReadline(channel: TerminalChannel) {
  const internals = channel as unknown as Internals;
  internals.rl = { question: vi.fn(), prompt: vi.fn(), close: vi.fn() };
  return internals;
}

describe('TerminalChannel regressions', () => {
  it('shows the prompt again when the handler resolves without replying', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const channel = new TerminalChannel({ userName: 'u' });
    const internals = withFakeReadline(channel);
    channel.onMessage(vi.fn().mockResolvedValue(undefined));

    await internals.handleInput('hello');

    expect(internals.rl!.question).toHaveBeenCalledTimes(1);
  });

  it('does not stack duplicate prompts', () => {
    const channel = new TerminalChannel({ userName: 'u' });
    const internals = withFakeReadline(channel);
    internals.showPrompt();
    internals.showPrompt();
    expect(internals.rl!.question).toHaveBeenCalledTimes(1);
  });

  it('/quit requests exit through onExit instead of killing the process', async () => {
    const onExit = vi.fn();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const channel = new TerminalChannel({ userName: 'u', onExit });
    withFakeReadline(channel);

    await (channel as unknown as Internals).handleInput('/quit');

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('stop() closes readline without requesting exit', async () => {
    const onExit = vi.fn();
    const channel = new TerminalChannel({ userName: 'u', onExit });
    const internals = withFakeReadline(channel);
    const close = internals.rl!.close;

    await channel.stop();

    expect(close).toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('redraws the prompt after an unsolicited message', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const channel = new TerminalChannel({ userName: 'u' });
    const internals = withFakeReadline(channel);
    internals.questionPending = true;

    await channel.sendText('terminal', 'Reminder!');

    expect(write.mock.calls[0][0]).toBe('\r\x1b[K');
    expect(internals.rl!.prompt).toHaveBeenCalledWith(true);
  });
});
