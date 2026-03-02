import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusReactionTracker } from '../status-reactions';
import type { Channel } from '@cogitator-ai/types';

function createMockChannel(): Channel & { setReaction: ReturnType<typeof vi.fn> } {
  return {
    type: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    sendText: vi.fn(),
    editText: vi.fn(),
    sendFile: vi.fn(),
    sendTyping: vi.fn(),
    setReaction: vi.fn().mockResolvedValue(undefined),
  };
}

describe('StatusReactionTracker', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = createMockChannel();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reacts immediately for done phase', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1');
    tracker.setPhase('done');

    expect(channel.setReaction).toHaveBeenCalledWith('ch1', 'msg1', '\u{1F44D}');
    tracker.dispose();
  });

  it('reacts immediately for error phase', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1');
    tracker.setPhase('error');

    expect(channel.setReaction).toHaveBeenCalledWith('ch1', 'msg1', '\u{1F631}');
    tracker.dispose();
  });

  it('debounces non-terminal phases', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 500,
    });

    tracker.setPhase('queued');
    expect(channel.setReaction).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(channel.setReaction).toHaveBeenCalledWith('ch1', 'msg1', '\u{1F440}');

    tracker.dispose();
  });

  it('skips rapid phase changes via debounce', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 500,
    });

    tracker.setPhase('queued');
    vi.advanceTimersByTime(200);

    tracker.setPhase('thinking');
    vi.advanceTimersByTime(500);

    expect(channel.setReaction).toHaveBeenCalledTimes(1);
    expect(channel.setReaction).toHaveBeenCalledWith('ch1', 'msg1', '\u{1F914}');

    tracker.dispose();
  });

  it('fires stall soft timer after stallSoftMs', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 100,
      stallSoftMs: 1000,
      stallHardMs: 5000,
    });

    tracker.setPhase('thinking');
    vi.advanceTimersByTime(100);
    expect(channel.setReaction).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(channel.setReaction).toHaveBeenCalledTimes(2);
    expect(channel.setReaction).toHaveBeenLastCalledWith('ch1', 'msg1', '\u{1F971}');

    tracker.dispose();
  });

  it('fires stall hard timer after stallHardMs', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 100,
      stallSoftMs: 1000,
      stallHardMs: 2000,
    });

    tracker.setPhase('thinking');
    vi.advanceTimersByTime(100);

    vi.advanceTimersByTime(2000);
    expect(channel.setReaction).toHaveBeenLastCalledWith('ch1', 'msg1', '\u{1F628}');

    tracker.dispose();
  });

  it('clears stall timers on phase change', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 100,
      stallSoftMs: 500,
    });

    tracker.setPhase('thinking');
    vi.advanceTimersByTime(100);
    channel.setReaction.mockClear();

    vi.advanceTimersByTime(300);
    tracker.setPhase('tool');
    vi.advanceTimersByTime(100);

    expect(channel.setReaction).toHaveBeenCalledTimes(1);
    expect(channel.setReaction).toHaveBeenCalledWith('ch1', 'msg1', '\u{1F525}');

    tracker.dispose();
  });

  it('dispose prevents further reactions', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 100,
    });

    tracker.setPhase('queued');
    tracker.dispose();
    vi.advanceTimersByTime(200);

    expect(channel.setReaction).not.toHaveBeenCalled();
  });

  it('uses custom emojis from config', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      emojis: { done: '\u{2705}' },
    });

    tracker.setPhase('done');
    expect(channel.setReaction).toHaveBeenCalledWith('ch1', 'msg1', '\u{2705}');
    tracker.dispose();
  });

  it('ignores duplicate phase', () => {
    const tracker = new StatusReactionTracker(channel, 'ch1', 'msg1', {
      debounceMs: 100,
    });

    tracker.setPhase('thinking');
    vi.advanceTimersByTime(100);

    tracker.setPhase('thinking');
    vi.advanceTimersByTime(100);

    expect(channel.setReaction).toHaveBeenCalledTimes(1);

    tracker.dispose();
  });
});
