import { useSyncExternalStore } from 'react';

function current(): string[] {
  return window.location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
}

/** The hash route as path segments: `#/runs/run_1` is `['runs', 'run_1']`. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(
    (listener) => {
      window.addEventListener('hashchange', listener);
      return () => window.removeEventListener('hashchange', listener);
    },
    () => window.location.hash
  );
  void hash;
  return current();
}

export function href(...parts: string[]): string {
  return `#/${parts.map(encodeURIComponent).join('/')}`;
}

export function navigate(...parts: string[]): void {
  window.location.hash = href(...parts);
}
