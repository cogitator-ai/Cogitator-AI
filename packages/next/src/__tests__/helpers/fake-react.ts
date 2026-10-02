type Cleanup = () => void;
type Deps = readonly unknown[] | undefined;

interface ReducerSlot<S, A> {
  state: S;
  dispatch: (action: A) => void;
}

interface CallbackSlot {
  fn: unknown;
  deps: Deps;
}

class HookRuntime<T> {
  private slots: unknown[] = [];
  private index = 0;
  private pendingEffects: Array<() => Cleanup | void> = [];
  private cleanups: Cleanup[] = [];
  private renderScheduled = false;
  private mounted = false;
  private unmounted = false;
  renders = 0;
  readonly result: { current: T | undefined } = { current: undefined };

  constructor(private readonly hook: () => T) {}

  render(): void {
    enterRuntime(this);
    this.index = 0;
    try {
      this.result.current = this.hook();
      this.renders++;
    } finally {
      enterRuntime(null);
    }
    if (!this.mounted) {
      this.mounted = true;
      for (const effect of this.pendingEffects) {
        const cleanup = effect();
        if (typeof cleanup === 'function') this.cleanups.push(cleanup);
      }
      this.pendingEffects = [];
    }
  }

  scheduleRender(): void {
    if (this.renderScheduled || this.unmounted) return;
    this.renderScheduled = true;
    setTimeout(() => {
      this.renderScheduled = false;
      if (!this.unmounted) this.render();
    }, 0);
  }

  unmount(): void {
    this.unmounted = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }

  nextSlot<S>(init: () => S): S {
    const i = this.index++;
    if (i >= this.slots.length) this.slots.push(init());
    return this.slots[i] as S;
  }

  registerEffect(effect: () => Cleanup | void): void {
    if (!this.mounted) this.pendingEffects.push(effect);
  }
}

let activeRuntime: HookRuntime<unknown> | null = null;

function enterRuntime(rt: HookRuntime<unknown> | null): void {
  activeRuntime = rt;
}

function runtime(): HookRuntime<unknown> {
  if (!activeRuntime) throw new Error('Hook called outside of renderHook');
  return activeRuntime;
}

function depsEqual(a: Deps, b: Deps): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((value, i) => Object.is(value, b[i]));
}

export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initial: S
): [S, (a: A) => void] {
  const rt = runtime();
  const slot = rt.nextSlot<ReducerSlot<S, A>>(() => {
    const created: ReducerSlot<S, A> = {
      state: initial,
      dispatch: (action: A) => {
        created.state = reducer(created.state, action);
        rt.scheduleRender();
      },
    };
    return created;
  });
  return [slot.state, slot.dispatch];
}

export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
  const resolved = typeof initial === 'function' ? (initial as () => S)() : initial;
  return useReducer<S, S | ((prev: S) => S)>(
    (state, next) => (typeof next === 'function' ? (next as (prev: S) => S)(state) : next),
    resolved
  );
}

export function useRef<V>(initial: V): { current: V } {
  return runtime().nextSlot(() => ({ current: initial }));
}

export function useCallback<F>(fn: F, deps: readonly unknown[]): F {
  const slot = runtime().nextSlot<CallbackSlot>(() => ({ fn, deps }));
  if (!depsEqual(slot.deps, deps)) {
    slot.fn = fn;
    slot.deps = deps;
  }
  return slot.fn as F;
}

export function useEffect(effect: () => Cleanup | void, _deps?: readonly unknown[]): void {
  runtime().registerEffect(effect);
}

export const reactApi = { useReducer, useState, useRef, useCallback, useEffect };

export interface RenderedHook<T> {
  result: { readonly current: T };
  unmount: () => void;
  flush: () => Promise<void>;
}

export function renderHook<T>(hook: () => T): RenderedHook<T> {
  const rt = new HookRuntime(hook);
  rt.render();
  return {
    result: {
      get current(): T {
        return rt.result.current as T;
      },
    },
    unmount: () => rt.unmount(),
    flush: () => new Promise((resolve) => setTimeout(resolve, 5)),
  };
}
