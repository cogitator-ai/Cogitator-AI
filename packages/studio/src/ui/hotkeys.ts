import { useEffect, useRef } from 'react';

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Whether the key went to a field, where letters are typed and not shortcuts. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/** Whether a dialog of the studio is open, which keeps page shortcuts quiet. */
export function dialogOpen(): boolean {
  return document.querySelector('[data-dialog]') !== null;
}

/**
 * Listens to keys on the window for as long as the component is mounted. The
 * handler is read on every key, so it can close over fresh state.
 */
export function useKeydown(handler: (event: KeyboardEvent) => void): void {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => current.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

/** A page shortcut: a plain key, not typed into a field, with no dialog open. */
export function usePageKey(keys: string[], handler: (event: KeyboardEvent) => void): void {
  useKeydown((event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event) || dialogOpen()) return;
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    handler(event);
  });
}
