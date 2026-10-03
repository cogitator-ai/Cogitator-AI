/** Landing demos run at this multiple of their authored timings, so a visitor can follow them. */
export const PACE = 1.9;

/** How long a demo rests on its final state before it starts over or the showcase moves on. */
export const FINAL_HOLD_MS = 6500;

/** Duration of step `index` in a timeline whose last step is the resting state. */
export function paced(durations: readonly number[], index: number): number {
  const base = (durations[index] ?? 1000) * PACE;
  return index === durations.length - 1 ? Math.max(base, FINAL_HOLD_MS) : base;
}
