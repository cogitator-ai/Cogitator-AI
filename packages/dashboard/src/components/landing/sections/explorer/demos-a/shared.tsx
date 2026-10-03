'use client';

import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from '../../../ui';
import { paced } from '../../../pace';

export const EASE = [0.16, 1, 0.3, 1] as const;

const noSubscription = () => () => {};

/** False during SSR and hydration, true afterwards, so the first client render matches the server. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false
  );
}

export interface DemoTimeline {
  ref: RefObject<HTMLDivElement | null>;
  /** Current step, `durations.length - 1` under reduced motion. */
  step: number;
  /** How many times the timeline has wrapped around. */
  loop: number;
  reduced: boolean;
}

/**
 * Steps through `durations` (ms per step) and loops while the demo is on screen.
 * Under `prefers-reduced-motion` it parks on the final step.
 */
export function useDemoTimeline(durations: readonly number[]): DemoTimeline {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-40px' });
  const hydrated = useHydrated();
  const prefersReduced = useReducedMotion() ?? false;
  const reduced = hydrated && prefersReduced;
  const last = durations.length - 1;
  const [position, setPosition] = useState({ step: 0, loop: 0 });

  useEffect(() => {
    if (reduced || !inView) return;
    const timer = setTimeout(
      () =>
        setPosition(({ step, loop }) =>
          step >= last ? { step: 0, loop: loop + 1 } : { step: step + 1, loop }
        ),
      paced(durations, position.step)
    );
    return () => clearTimeout(timer);
  }, [durations, inView, last, position.step, reduced]);

  return { ref, step: reduced ? last : position.step, loop: position.loop, reduced };
}

/** Fades and lifts its children in when `show` turns true. */
export function Reveal({
  show,
  children,
  className,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className={className}
          initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Types `text` out while `play` is true; shows it whole otherwise. */
export function Streamed({
  text,
  play,
  speed = 2,
}: {
  text: string;
  play: boolean;
  speed?: number;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(play && !reduced ? 0 : text.length);

  useEffect(() => {
    if (!play || reduced) {
      setShown(text.length);
      return;
    }
    setShown(0);
    const interval = setInterval(() => {
      setShown((count) => {
        if (count >= text.length) {
          clearInterval(interval);
          return count;
        }
        return count + speed;
      });
    }, 34);
    return () => clearInterval(interval);
  }, [play, reduced, speed, text]);

  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span aria-hidden className="crt-cursor ml-0.5" />}
    </>
  );
}

/** The quiet top bar every mini-demo shares. */
export function DemoBar({ label, right }: { label: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-l-line px-4">
      <span className="min-w-0 truncate font-mono text-[11px] text-l-faint">{label}</span>
      {right}
    </div>
  );
}

/** A small pill for state labels inside demos. */
export function Pill({
  children,
  active,
  done,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  done?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] leading-4 transition-colors duration-300',
        active
          ? 'border-l-accent/40 bg-l-accent/[0.08] text-l-accent'
          : done
            ? 'border-l-brass/25 text-l-brass/80'
            : 'border-l-line text-l-faint',
        className
      )}
    >
      {children}
    </span>
  );
}
