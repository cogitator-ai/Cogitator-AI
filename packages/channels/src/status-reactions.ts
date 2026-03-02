import type { Channel, StatusPhase, StatusReactionConfig } from '@cogitator-ai/types';

const DEFAULT_EMOJIS: Record<StatusPhase, string> = {
  queued: '\u{1F440}',
  thinking: '\u{1F914}',
  tool: '\u{1F525}',
  done: '\u{1F44D}',
  error: '\u{1F631}',
};

const STALL_SOFT_EMOJI = '\u{1F971}';
const STALL_HARD_EMOJI = '\u{1F628}';

export class StatusReactionTracker {
  private currentPhase: StatusPhase | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stallSoftTimer: ReturnType<typeof setTimeout> | null = null;
  private stallHardTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly stallSoftMs: number;
  private readonly stallHardMs: number;
  private readonly emojis: Record<StatusPhase, string>;
  private disposed = false;

  constructor(
    private readonly channel: Channel,
    private readonly channelId: string,
    private readonly messageId: string,
    config?: StatusReactionConfig
  ) {
    this.debounceMs = config?.debounceMs ?? 700;
    this.stallSoftMs = config?.stallSoftMs ?? 10_000;
    this.stallHardMs = config?.stallHardMs ?? 30_000;
    this.emojis = { ...DEFAULT_EMOJIS, ...config?.emojis };
  }

  setPhase(phase: StatusPhase): void {
    if (this.disposed) return;
    if (phase === this.currentPhase) return;

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.clearStallTimers();

    if (phase === 'done' || phase === 'error') {
      this.currentPhase = phase;
      void this.react(this.emojis[phase]);
      return;
    }

    this.debounceTimer = setTimeout(() => {
      if (this.disposed) return;
      this.currentPhase = phase;
      void this.react(this.emojis[phase]);
      this.startStallTimers();
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.clearStallTimers();
  }

  private startStallTimers(): void {
    this.stallSoftTimer = setTimeout(() => {
      if (!this.disposed) void this.react(STALL_SOFT_EMOJI);
    }, this.stallSoftMs);

    this.stallHardTimer = setTimeout(() => {
      if (!this.disposed) void this.react(STALL_HARD_EMOJI);
    }, this.stallHardMs);
  }

  private clearStallTimers(): void {
    if (this.stallSoftTimer) {
      clearTimeout(this.stallSoftTimer);
      this.stallSoftTimer = null;
    }
    if (this.stallHardTimer) {
      clearTimeout(this.stallHardTimer);
      this.stallHardTimer = null;
    }
  }

  private async react(emoji: string): Promise<void> {
    try {
      await this.channel.setReaction?.(this.channelId, this.messageId, emoji);
    } catch {}
  }
}
