import type { HookName, HookHandler, HookRegistry } from '@cogitator-ai/types';

export type { HookName, HookHandler, HookRegistry };

export function createHookRegistry(): HookRegistry {
  const hooks = new Map<HookName, Set<HookHandler>>();

  return {
    on(hook: HookName, handler: HookHandler): void {
      let set = hooks.get(hook);
      if (!set) {
        set = new Set();
        hooks.set(hook, set);
      }
      set.add(handler);
    },

    off(hook: HookName, handler: HookHandler): void {
      hooks.get(hook)?.delete(handler);
    },

    async emit(hook: HookName, event: unknown): Promise<void> {
      const set = hooks.get(hook);
      if (!set) return;
      for (const handler of set) {
        try {
          await handler(event);
        } catch (err) {
          console.error(`[hooks] Error in "${hook}" handler:`, err);
        }
      }
    },
  };
}
