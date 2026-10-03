'use client';

import { useInView, usePageInView, type UseInViewOptions } from 'framer-motion';
import type { RefObject } from 'react';

/**
 * Whether a demo should be playing: its element is in view and its browser tab is visible.
 * Demos drive their timelines with timers, so they stop on a hidden tab instead of ticking on.
 */
export function useOnScreen(ref: RefObject<Element | null>, options?: UseInViewOptions): boolean {
  const inView = useInView(ref, options);
  const pageVisible = usePageInView();
  return inView && pageVisible;
}
