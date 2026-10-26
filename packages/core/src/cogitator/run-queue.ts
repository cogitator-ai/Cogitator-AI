import type {
  MessageContent,
  QueueDrainMode,
  QueuedRunMessage,
  RefusedRunMessage,
  RunQueueKind,
  RunQueueOptions,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/**
 * The messages given to a run going on (`cogitator.start()`), waiting for the run to take them.
 * The run takes steering and injected messages before each model call, and steering or
 * follow-up messages when it would stop. Once the run no longer takes messages it closes the
 * queue: later messages are refused, and what was left stays readable as {@link pending} until
 * the run saves it ({@link claim}) or the caller cancels the run ({@link cancel}).
 */
export class RunQueue {
  private readonly items: QueuedRunMessage[] = [];
  /** Messages the run took and is checking, not delivered yet */
  private readonly inFlight: QueuedRunMessage[] = [];
  private readonly refusals: RefusedRunMessage[] = [];
  private closed = false;
  private readonly steering: QueueDrainMode;
  private readonly followUp: QueueDrainMode;
  private readonly watchers: ((pending: readonly QueuedRunMessage[]) => void)[] = [];

  /** @param onRefused hears of each message the run's input checks refused */
  constructor(
    options: RunQueueOptions = {},
    private readonly onRefused?: (refused: RefusedRunMessage) => void
  ) {
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
    this.changed();
    return true;
  }

  /**
   * Calls `watcher` with the messages not delivered yet each time messages come, are cancelled,
   * claimed or refused. A delivered one (`settle`) is left to the run, which records it with what
   * it added to the conversation
   */
  watch(watcher: (pending: readonly QueuedRunMessage[]) => void): void {
    this.watchers.push(watcher);
  }

  private changed(): void {
    if (this.watchers.length === 0) return;
    const pending = this.pending;
    for (const watcher of this.watchers) watcher(pending);
  }

  /** The messages not delivered yet, those the run is checking first, in the order they came */
  get pending(): readonly QueuedRunMessage[] {
    return [...this.inFlight, ...this.items];
  }

  /** The messages the run's input checks refused, in the order it refused them */
  get refused(): readonly RefusedRunMessage[] {
    return [...this.refusals];
  }

  /**
   * Notes that the run's input checks refused `message`, taken out of the queue already or now:
   * it never reaches the model or the thread
   */
  refuse(message: QueuedRunMessage, error: Error): void {
    this.claim(message);
    if (this.settle(message)) this.changed();
    const refused: RefusedRunMessage = { kind: message.kind, content: message.content, error };
    this.refusals.push(refused);
    this.onRefused?.(refused);
  }

  /** Whether the run still takes messages */
  get open(): boolean {
    return !this.closed;
  }

  /**
   * What the next model call takes: every injected message and steering ones by their mode, or
   * only the injected ones with `injectsOnly`, for a call that got a steering message already
   */
  takeForTurn(injectsOnly = false): QueuedRunMessage[] {
    return this.take(
      (message) => message.kind === 'inject',
      'steer',
      injectsOnly ? 'none' : this.steering
    );
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
    return this.pending.slice();
  }

  /**
   * Stops taking messages and takes every one left out of the queue: the run will not deliver or
   * save any of them, so they are exactly what never reached it
   */
  cancel(): QueuedRunMessage[] {
    this.closed = true;
    const left = [...this.inFlight.splice(0), ...this.items.splice(0)];
    if (left.length > 0) this.changed();
    return left;
  }

  /**
   * The run delivers `message` it took: false when it may not, as {@link cancel} handed it back
   * while the run checked it
   */
  settle(message: QueuedRunMessage): boolean {
    const index = this.inFlight.indexOf(message);
    if (index === -1) return false;
    this.inFlight.splice(index, 1);
    return true;
  }

  /**
   * Takes `message` out of the queue for the run to save it, false when it is no longer there,
   * such as after {@link cancel}
   */
  claim(message: QueuedRunMessage): boolean {
    const index = this.items.indexOf(message);
    if (index === -1) return false;
    this.items.splice(index, 1);
    this.changed();
    return true;
  }

  private take(
    always: (message: QueuedRunMessage) => boolean,
    kind: RunQueueKind,
    mode: QueueDrainMode | 'none'
  ): QueuedRunMessage[] {
    if (this.closed) return [];
    const taken: QueuedRunMessage[] = [];
    let ofKind = 0;
    for (let index = 0; index < this.items.length;) {
      const message = this.items[index];
      const takesIt =
        always(message) ||
        (message.kind === kind && (mode === 'all' || (mode === 'one-at-a-time' && ofKind === 0)));
      if (!takesIt) {
        index++;
        continue;
      }
      if (message.kind === kind) ofKind++;
      taken.push(message);
      this.items.splice(index, 1);
    }
    this.inFlight.push(...taken);
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
