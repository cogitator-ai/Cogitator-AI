'use client';

import { createContext, useContext } from 'react';
import { paced } from '../../pace';

/**
 * How a demo talks to the explorer around it: it reports where it is in its timeline, so the
 * explorer's progress bar matches the demo, and asks at the end of a cycle whether to move on.
 */
export interface DemoCycle {
  /** A step started `elapsedMs` into a cycle of `totalMs` and lasts `stepMs`. */
  step(elapsedMs: number, stepMs: number, totalMs: number): void;
  /** The cycle is over; returns true when the explorer moved to another feature. */
  complete(): boolean;
}

export const DemoCycleContext = createContext<DemoCycle | null>(null);

export function useDemoCycle(): DemoCycle | null {
  return useContext(DemoCycleContext);
}

/** Paced timing of step `index`: when it starts, how long it lasts, and the cycle's total. */
export function cycleTiming(
  durations: readonly number[],
  index: number
): { elapsedMs: number; stepMs: number; totalMs: number } {
  let elapsedMs = 0;
  let totalMs = 0;
  durations.forEach((_, i) => {
    const ms = paced(durations, i);
    if (i < index) elapsedMs += ms;
    totalMs += ms;
  });
  return { elapsedMs, stepMs: paced(durations, index), totalMs };
}
