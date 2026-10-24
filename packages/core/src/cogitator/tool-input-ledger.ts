import type {
  ToolCall,
  ToolInputAbandoned,
  ToolInputAvailable,
  ToolInputStart,
} from '@cogitator-ai/types';

/**
 * The tool calls the model began to write in one turn, so each one ends either running or
 * abandoned: once the turn is settled, every call it did not keep is reported with why.
 */
export class ToolInputLedger {
  private readonly open = new Map<string, { toolName: string; available: boolean }>();

  constructor(private readonly onAbandoned: (event: ToolInputAbandoned) => void) {}

  started(event: ToolInputStart): void {
    if (!this.open.has(event.toolCallId)) {
      this.open.set(event.toolCallId, { toolName: event.toolName, available: false });
    }
  }

  available(event: ToolInputAvailable): void {
    const call = this.open.get(event.toolCallId);
    if (call) call.available = true;
  }

  /**
   * The turn is settled with the calls it keeps: the other calls begun in it are abandoned, and
   * so is a call an `afterModel` middleware gave another tool
   */
  settle(kept: readonly ToolCall[]): void {
    const keptNames = new Map(kept.map((call) => [call.id, call.name]));
    const left = [...this.open.entries()].filter(
      ([id, call]) => keptNames.get(id) !== call.toolName
    );
    this.open.clear();
    for (const [toolCallId, call] of left) {
      this.onAbandoned({
        toolCallId,
        toolName: call.toolName,
        reason: call.available ? 'discarded' : 'incomplete',
      });
    }
  }

  /** The turn failed or was aborted: no call begun in it runs */
  abandonAll(): void {
    this.settle([]);
  }
}
