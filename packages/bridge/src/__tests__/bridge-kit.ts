import { BridgeDispatcher, type BridgeDispatcherOptions } from '../dispatcher';
import { SqliteBridgeStore } from '../store/sqlite';
import type {
  BridgeAdapter,
  CreatedSession,
  DeliveryReceipt,
  LetterDelivery,
  LiveSession,
  SessionRequest,
} from '../adapter';
import type { AdapterCapabilities, AgentRecord } from '../types';
import { T0 } from './helpers';

export class Clock {
  private time = T0;
  now = (): number => this.time;
  advance(ms: number): void {
    this.time += ms;
  }
}

export interface FakeAdapterOptions {
  harness?: string;
  capabilities?: Partial<AdapterCapabilities>;
  deliver?: (delivery: LetterDelivery) => Promise<DeliveryReceipt | void>;
  createSession?: (request: SessionRequest) => Promise<CreatedSession>;
  /** The sessions the harness lists as running, asked every time */
  liveSessions?: () => Promise<LiveSession[]>;
  /** Whether a session of the harness wakes for a letter, asked every time */
  wakesFor?: (agent: AgentRecord) => Promise<boolean>;
}

/** An adapter that remembers what it was asked to do. */
export class FakeAdapter implements BridgeAdapter {
  readonly harness: string;
  readonly delivery = 'fake';
  readonly capabilities: AdapterCapabilities;
  readonly delivered: LetterDelivery[] = [];
  readonly sessions: SessionRequest[] = [];
  readonly createSession?: (request: SessionRequest) => Promise<CreatedSession>;
  readonly liveSessions?: () => Promise<LiveSession[]>;
  readonly wakesFor?: (agent: AgentRecord) => Promise<boolean>;
  private readonly onDeliver?: (delivery: LetterDelivery) => Promise<DeliveryReceipt | void>;

  constructor(options: FakeAdapterOptions = {}) {
    this.harness = options.harness ?? 'codex';
    this.capabilities = {
      createSession: options.createSession !== undefined,
      push: true,
      steer: false,
      nativeWindow: true,
      ...options.capabilities,
    };
    this.onDeliver = options.deliver;
    if (options.liveSessions) this.liveSessions = options.liveSessions;
    if (options.wakesFor) this.wakesFor = options.wakesFor;
    if (options.createSession) {
      const create = options.createSession;
      this.createSession = async (request) => {
        this.sessions.push(request);
        return create(request);
      };
    }
  }

  async deliver(delivery: LetterDelivery): Promise<DeliveryReceipt | void> {
    const receipt = await this.onDeliver?.(delivery);
    this.delivered.push(delivery);
    return receipt;
  }

  get texts(): string[] {
    return this.delivered.map((delivery) => delivery.letter.text);
  }
}

export interface Kit {
  bridge: BridgeDispatcher;
  store: SqliteBridgeStore;
  clock: Clock;
  errors: Error[];
  claude: AgentRecord;
  codex: AgentRecord;
  close: () => Promise<void>;
}

/** A dispatcher on a store in memory, with a Claude Code and a Codex session of one project. */
export async function makeKit(
  options: Omit<Partial<BridgeDispatcherOptions>, 'store' | 'now'> = {}
): Promise<Kit> {
  const store = await SqliteBridgeStore.open(':memory:');
  const clock = new Clock();
  const errors: Error[] = [];
  let letters = 0;
  const bridge = new BridgeDispatcher({
    store,
    now: clock.now,
    newLetterId: () => `ltr_${(letters += 1)}`,
    onError: (error) => errors.push(error),
    ...options,
  });
  const claude = await bridge.register({
    harness: 'claude-code',
    sessionId: 'session-claude',
    cwd: '/work/demo',
    project: '/work/demo',
  });
  const codex = await bridge.register({
    harness: 'codex',
    sessionId: 'thread-codex',
    cwd: '/work/demo',
    project: '/work/demo',
  });
  return {
    bridge,
    store,
    clock,
    errors,
    claude,
    codex,
    close: async () => {
      await bridge.close();
      store.close();
    },
  };
}

export const MINUTE = 60_000;
