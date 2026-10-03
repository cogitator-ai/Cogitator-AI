'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const clientPath = () => window.location.pathname;
const serverPath = () => null;

/**
 * The path that was requested, for the 404 page's vox log. The page is prerendered once for every
 * missing URL, so the path is read from the browser after hydration rather than baked into the HTML.
 */
export function RequestedPath() {
  return useSyncExternalStore(subscribe, clientPath, serverPath);
}
