import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalChannel } from '../channels/terminal';

describe('TerminalChannel', () => {
  let channel: TerminalChannel;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    channel = new TerminalChannel({ userName: 'TestUser', userId: 'test-user' });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('has type terminal', () => {
    expect(channel.type).toBe('terminal');
  });

  it('sendText writes to stdout and returns message id', async () => {
    const id = await channel.sendText('terminal', 'Hello world');
    expect(id).toMatch(/^term_\d+$/);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('Hello world');
  });

  it('sendText returns unique ids', async () => {
    const id1 = await channel.sendText('terminal', 'first');
    const id2 = await channel.sendText('terminal', 'second');
    expect(id1).not.toBe(id2);
  });

  it('editText clears previous output and rewrites', async () => {
    await channel.sendText('terminal', 'initial');
    stdoutSpy.mockClear();

    await channel.editText('terminal', 'term_1', 'updated text');

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('\x1b[');
    expect(output).toContain('updated text');
  });

  it('editText handles multiline content', async () => {
    await channel.sendText('terminal', 'line1\nline2\nline3');
    stdoutSpy.mockClear();

    await channel.editText('terminal', 'term_1', 'new1\nnew2');

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('3A');
    expect(output).toContain('new1\nnew2');
  });

  it('sendFile prints file info', async () => {
    await channel.sendFile('terminal', {
      type: 'file',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      url: 'https://example.com/report.pdf',
    });

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('report.pdf');
    expect(output).toContain('https://example.com/report.pdf');
  });

  it('sendTyping is a no-op', async () => {
    await channel.sendTyping('terminal');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('onMessage stores handler and it gets called', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    await (channel as unknown as { handleInput(s: string): Promise<void> }).handleInput('hello');

    expect(handler).toHaveBeenCalledTimes(1);
    const calledMsg = handler.mock.calls[0][0] as ChannelMessage;
    expect(calledMsg.channelType).toBe('terminal');
    expect(calledMsg.text).toBe('hello');
    expect(calledMsg.userId).toBe('test-user');
    expect(calledMsg.userName).toBe('TestUser');
  });

  it('empty input does not call handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onMessage(handler);

    await (channel as unknown as { handleInput(s: string): Promise<void> }).handleInput('   ');
    expect(handler).not.toHaveBeenCalled();
  });

  it('stop cleans up', async () => {
    await channel.stop();
  });
});
