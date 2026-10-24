import type {
  MessageContent,
  QueueDrainMode,
  QueuedRunMessage,
  RunQueueKind,
  RunQueueOptions,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/**
 * The messages given to a run going on (`cogitator.start()`), waiting for the run to take them.
 * The run takes steering and injected messages before each model call, and steering or
 * follow-up messages when it would stop. Once the run no longer takes messages it closes the
 * queue: later messages are refused, and what was left stays readable as {@link pending}.
 */
export class RunQueue {
  private readonly items: QueuedRunMessage[] = [];
  private closed = false;
  private readonly steering: QueueDrainMode;
  private readonly followUp: QueueDrainMode;

  constructor(options: RunQueueOptions = {}) {
    this.steering = drainMode(options.steering, 'queue.steering');
    this.followUp = drainMode(options.followUp, 'queue.followUp');
  }

  /** Queues a message, false once the queue is closed */
  push(kind: RunQueueKind, content: MessageContent): boolean {
    if (this.closed) return false;
    if (isEmpty(content)) {
      throw new CogitatorError({
        message: `A ${kind} message must not be empty`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    this.items.push({ kind, content });
    return true;
  }

  /** The messages waiting, in the order they came */
  get pending(): readonly QueuedRunMessage[] {
    return [...this.items];
  }

  /** Whether the run still takes messages */
  get open(): boolean {
    return !this.closed;
  }

  /** What the next model call takes: every injected message and steering ones by their mode */
  takeForTurn(): QueuedRunMessage[] {
    return this.take((message) => message.kind === 'inject', 'steer', this.steering);
  }

  /**
   * What wakes an agent about to stop: steering messages by their mode, or when there are none,
   * follow-ups by theirs, with every injected message that waits. Nothing while neither waits
   */
  takeAtStop(): QueuedRunMessage[] {
    if (this.items.some((message) => message.kind === 'steer')) return this.takeForTurn();
    if (!this.items.some((message) => message.kind === 'followUp')) return [];
    return this.take((message) => message.kind === 'inject', 'followUp', this.followUp);
  }

  /** Stops taking messages and returns the ones left, in the order they came */
  close(): QueuedRunMessage[] {
    this.closed = true;
    return [...this.items];
  }

  private take(
    always: (message: QueuedRunMessage) => boolean,
    kind: RunQueueKind,
    mode: QueueDrainMode
  ): QueuedRunMessage[] {
    if (this.closed) return [];
    const taken: QueuedRunMessage[] = [];
    let ofKind = 0;
    for (let index = 0; index < this.items.length;) {
      const message = this.items[index];
      const takesIt =
        always(message) || (message.kind === kind && (mode === 'all' || ofKind === 0));
      if (!takesIt) {
        index++;
        continue;
      }
      if (message.kind === kind) ofKind++;
      taken.push(message);
      this.items.splice(index, 1);
    }
    return taken;
  }
}

function drainMode(mode: QueueDrainMode | undefined, field: string): QueueDrainMode {
  if (mode === undefined) return 'one-at-a-time';
  if (mode === 'all' || mode === 'one-at-a-time') return mode;
  throw new CogitatorError({
    message: `${field} must be 'all' or 'one-at-a-time', got ${String(mode)}`,
    code: ErrorCode.CONFIGURATION_ERROR,
  });
}

function isEmpty(content: MessageContent): boolean {
  return typeof content === 'string' ? content.trim() === '' : content.length === 0;
}
