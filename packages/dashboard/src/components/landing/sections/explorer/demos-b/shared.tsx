'use client';

import { AnimatePresence, MotionConfig, motion, useInView, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx } from '../../../ui';
import { cycleTiming, useDemoCycle } from '../cycle';

export const EASE = [0.16, 1, 0.3, 1] as const;

export interface DemoTimeline {
  ref: RefObject<HTMLDivElement | null>;
  step: number;
  reduced: boolean;
  /** Jump to a step; under reduced motion the demo then rests on it. */
  goTo: (step: number) => void;
}

/**
 * Steps through `durations` while the demo is on screen and loops back to 0.
 * Under `prefers-reduced-motion` it stays on the last (complete) step.
 */
export function useDemoTimeline(durations: readonly number[]): DemoTimeline {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-40px' });
  const reduced = useReducedMotion() ?? false;
  const last = durations.length - 1;
  const [step, setStep] = useState(0);
  const [pinned, setPinned] = useState<number | null>(null);
  const cycle = useDemoCycle();

  useEffect(() => {
    if (reduced || !inView) return;
    const { elapsedMs, stepMs, totalMs } = cycleTiming(durations, step);
    cycle?.step(elapsedMs, stepMs, totalMs);
    const timer = setTimeout(() => {
      if (step >= last && cycle?.complete()) return;
      setStep((current) => (current >= last ? 0 : current + 1));
    }, stepMs);
    return () => clearTimeout(timer);
  }, [cycle, durations, inView, last, reduced, step]);

  const goTo = useCallback((target: number) => {
    setPinned(target);
    setStep(target);
  }, []);

  return { ref, step: reduced ? (pinned ?? last) : step, reduced, goTo };
}

/** Fades a block in when `show` turns true and out when the loop restarts. */
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
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The demo surface: a quiet header strip, the body, and an optional metadata footer. */
export function DemoFrame({
  timeline,
  label,
  aside,
  footer,
  children,
  bodyClassName,
}: {
  timeline: DemoTimeline;
  label: ReactNode;
  aside?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <MotionConfig reducedMotion="user">
      <div ref={timeline.ref} className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-l-line px-4">
          <span className="min-w-0 truncate font-mono text-[11px] text-l-faint">{label}</span>
          {aside}
        </div>
        <div className={cx('relative min-h-0 flex-1 overflow-hidden px-4 py-3', bodyClassName)}>
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-l-line px-4 py-2 font-mono text-[10.5px] text-l-faint">
            {footer}
          </div>
        )}
      </div>
    </MotionConfig>
  );
}

/** A small segmented control for demos that cycle through several scenes. */
export function SceneTabs({
  scenes,
  active,
  onSelect,
  label,
}: {
  scenes: readonly string[];
  active: number;
  onSelect: (index: number) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-l-brass/20 p-0.5"
    >
      {scenes.map((scene, index) => (
        <button
          key={scene}
          type="button"
          aria-pressed={index === active}
          onClick={() => onSelect(index)}
          className={cx(
            'rounded px-1.5 py-0.5 font-mono text-[10px] leading-4 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-l-accent/60',
            index === active ? 'bg-l-brass/[0.1] text-l-brass' : 'text-l-faint hover:text-l-muted'
          )}
        >
          {scene}
        </button>
      ))}
    </div>
  );
}

/** A hairline mono chip for limits, ids and other metadata. */
export function Chip({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'info' | 'violet' | 'brass';
  className?: string;
}) {
  const tones = {
    neutral: 'border-l-line text-l-muted',
    accent: 'border-l-accent/25 text-l-accent',
    warn: 'border-l-warn/25 text-l-warn',
    danger: 'border-l-danger/25 text-l-danger',
    info: 'border-l-info/25 text-l-info',
    violet: 'border-l-violet/25 text-l-violet',
    brass: 'border-l-brass/30 text-l-brass',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px font-mono text-[10.5px] leading-4',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/** Text that types itself out once `play` turns true. */
export function Typed({
  text,
  play,
  speed = 28,
  cursor = true,
}: {
  text: string;
  play: boolean;
  speed?: number;
  cursor?: boolean;
}) {
  const reduced = useReducedMotion() ?? false;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!play || reduced) return;
    const interval = setInterval(() => {
      setShown((count) => {
        if (count >= text.length) {
          clearInterval(interval);
          return count;
        }
        return count + 1;
      });
    }, speed * 1.4);
    return () => {
      clearInterval(interval);
      setShown(0);
    };
  }, [play, reduced, speed, text]);

  const visible = !play || reduced ? text.length : shown;
  return (
    <>
      {text.slice(0, visible)}
      {cursor && play && !reduced && visible < text.length && (
        <span aria-hidden className="crt-cursor ml-px" />
      )}
    </>
  );
}
