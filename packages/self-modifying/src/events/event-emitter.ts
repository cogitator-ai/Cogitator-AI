import type {
  SelfModifyingEvent,
  SelfModifyingEventType,
  SelfModifyingEventHandler,
} from '@cogitator-ai/types';

export type { SelfModifyingEventHandler };

export class SelfModifyingEventEmitter {
  private handlers = new Map<SelfModifyingEventType | '*', Set<SelfModifyingEventHandler>>();

  on(event: SelfModifyingEventType | '*', handler: SelfModifyingEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: SelfModifyingEventType | '*', handler: SelfModifyingEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  async emit(event: SelfModifyingEvent): Promise<void> {
    const typeHandlers = this.handlers.get(event.type);
    const wildcardHandlers = this.handlers.get('*');

    const allHandlers = [
      ...(typeHandlers ? [...typeHandlers] : []),
      ...(wildcardHandlers ? [...wildcardHandlers] : []),
    ];

    await Promise.all(allHandlers.map((h) => h(event)));
  }

  createEvent(
    type: SelfModifyingEventType,
    runId: string,
    agentId: string,
    data: unknown
  ): SelfModifyingEvent {
    return {
      type,
      runId,
      agentId,
      timestamp: new Date(),
      data,
    };
  }

  removeAllListeners(event?: SelfModifyingEventType | '*'): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  listenerCount(event: SelfModifyingEventType | '*'): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
