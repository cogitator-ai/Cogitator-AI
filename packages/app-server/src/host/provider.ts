import type { StreamEvent } from '@cogitator-ai/server-shared';
import type {
  PermissionMode,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';
import type { UserInput } from '../protocol/types.js';

/** A turn of a thread whose agent runs outside the runtime, see {@link SessionProvider} */
export interface SessionProviderTurn {
  readonly threadId: string;
  readonly turnId: string;
  /** What the user sent */
  readonly input: readonly UserInput[];
  /**
   * The thread's metadata as the turn starts: where a provider keeps its own state, such as the
   * id of its session with the agent
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Merges `patch` into the thread's metadata */
  saveMetadata(patch: Record<string, unknown>): Promise<void>;
  /** The permission mode of the turn now: setting the thread's mode while the turn goes on changes it */
  permissionMode(): PermissionMode;
  /** The model the turn asked for, when it named one */
  readonly model?: string;
  /**
   * Sends an event of the turn's stream: text, reasoning and tool calls. The host sends `start`
   * and `finish` itself
   */
  emit(event: StreamEvent): void;
  /**
   * Asks the client that started the turn about a tool call, when it takes questions. `'pause'`
   * means nobody answered: an agent outside the runtime cannot pause, so refuse the call then
   */
  readonly onApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision | 'pause'>;
  /** Aborts when the turn is interrupted or the host closes: stop the agent then */
  readonly signal: AbortSignal;
}

/** How a turn of a {@link SessionProvider} ended */
export interface SessionProviderResult {
  /** The answer of the agent */
  output: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; cost?: number };
  /** The answer stopped at the output token limit */
  truncated?: boolean;
  /** The agent declined to answer */
  refused?: boolean;
}

/**
 * An agent that runs outside the runtime, such as an ACP agent the host launched, serving the
 * threads of its name next to the runtime's agents. The host keeps the thread, its user and
 * assistant messages and its turns, the provider runs each turn: its events reach the clients as
 * those of any turn. A provider's threads cannot be forked, rewound or reviewed, and a turn of
 * one takes no steering. Whoever made a provider closes it, the host never does
 */
export interface SessionProvider {
  readonly description?: string;
  /** The model the agent runs, when it is known */
  readonly model?: string;
  /** Runs one turn, resolving once the agent answered. It rejects when the turn failed */
  runTurn(turn: SessionProviderTurn): Promise<SessionProviderResult>;
}
