/**
 * Event emitter for swarm coordination
 */

import type {
  SwarmEventEmitter,
  SwarmEventType,
  SwarmEvent,
  SwarmEventHandler,
} from '@cogitator/types';

export class SwarmEventEmitterImpl implements SwarmEventEmitter {
  private handlers = new Map<SwarmEventType | '*', Set<SwarmEventHandler>>();
  private events: SwarmEvent[] = [];
  private maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => this.off(event, handler);
  }

  once(event: SwarmEventType, handler: SwarmEventHandler): () => void {
    const wrapper: SwarmEventHandler = (e) => {
      this.off(event, wrapper);
      handler(e);
    };
    return this.on(event, wrapper);
  }

  emit(event: SwarmEventType, data?: unknown, agentName?: string): void {
    const swarmEvent: SwarmEvent = {
      type: event,
      timestamp: Date.now(),
      agentName,
      data,
    };

    this.events.push(swarmEvent);

    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(swarmEvent);
        } catch {
        }
      }
    }

    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(swarmEvent);
        } catch {
        }
      }
    }
  }

  off(event: SwarmEventType | '*', handler: SwarmEventHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  removeAllListeners(event?: SwarmEventType): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  getEvents(): SwarmEvent[] {
    return [...this.events];
  }

  getEventsByType(type: SwarmEventType): SwarmEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  getEventsByAgent(agentName: string): SwarmEvent[] {
    return this.events.filter((e) => e.agentName === agentName);
  }

  clearEvents(): void {
    this.events = [];
  }
}
