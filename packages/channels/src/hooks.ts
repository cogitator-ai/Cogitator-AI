import type { HookName, HookHandler, HookPayloads, HookRegistry } from '@cogitator-ai/types';

export type { HookName, HookHandler, HookPayloads, HookRegistry };

type HandlerSets = { [K in HookName]: Set<HookHandler<HookPayloads[K]>> };

export function createHookRegistry(): HookRegistry {
  const hooks: HandlerSets = {
    'message:received': new Set(),
    'message:sending': new Set(),
    'message:sent': new Set(),
    'agent:before_run': new Set(),
    'agent:after_run': new Set(),
    'agent:error': new Set(),
    'session:created': new Set(),
    'session:compacted': new Set(),
    'stream:started': new Set(),
    'stream:finished': new Set(),
    'approval:requested': new Set(),
    'approval:resolved': new Set(),
  };

  return {
    on<K extends HookName>(hook: K, handler: HookHandler<HookPayloads[K]>): void {
      hooks[hook].add(handler);
    },

    off<K extends HookName>(hook: K, handler: HookHandler<HookPayloads[K]>): void {
      hooks[hook].delete(handler);
    },

    async emit<K extends HookName>(hook: K, event: HookPayloads[K]): Promise<void> {
      for (const handler of hooks[hook]) {
        try {
          await handler(event);
        } catch (err) {
          console.error(`[hooks] Error in "${hook}" handler:`, err);
        }
      }
    },
  };
}
