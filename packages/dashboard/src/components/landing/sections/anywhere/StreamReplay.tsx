'use client';

import { m, useReducedMotion } from 'framer-motion';
import { useOnScreen } from '../../playback';
import { useEffect, useRef, useState } from 'react';
import { Vox, cx } from '../../ui';
import type { StreamLine, StreamScript, StreamTone } from './types';
import { FINAL_HOLD_MS, PACE } from '../../pace';

const FIRST_EVENT_DELAY = 800;
const FINAL_HOLD = 3200;
const TONE_DELAY: Record<StreamTone, number> = { meta: 280, tool: 420, text: 300 };

const LABEL_TONE: Record<StreamTone, string> = {
  meta: 'text-l-faint',
  tool: 'text-l-violet',
  text: 'text-l-accent crt-glow',
};

function useReplay(events: StreamLine[], active: boolean, reduced: boolean): number {
  const [shown, setShown] = useState(0);
  const total = events.length;

  useEffect(() => {
    if (reduced) {
      setShown(total);
      return;
    }
    if (!active) return;
    const delay =
      shown === 0
        ? FIRST_EVENT_DELAY * PACE
        : shown >= total
          ? Math.max(FINAL_HOLD * PACE, FINAL_HOLD_MS)
          : TONE_DELAY[events[shown]?.tone ?? 'meta'] * PACE;
    const timer = setTimeout(() => setShown((count) => (count >= total ? 0 : count + 1)), delay);
    return () => clearTimeout(timer);
  }, [active, reduced, shown, total, events]);

  return shown;
}

/** Replays a request and the events its response streams back, one event at a time. */
export function StreamReplay({ script, runtime }: { script: StreamScript; runtime: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useOnScreen(ref, { margin: '-80px' });
  const reduced = useReducedMotion() ?? false;
  const shown = useReplay(script.events, inView, reduced);
  const visible = script.events.slice(0, shown);
  const answer = visible.map((event) => event.delta ?? '').join('');
  const done = shown >= script.events.length;

  return (
    <div ref={ref} className="crt flex min-w-0 flex-col bg-l-bg/50 lg:min-h-[470px]">
      <div className="flex items-center justify-between gap-3 border-b border-l-line px-4 py-2.5 font-mono text-[11px]">
        <span className="text-l-faint">request → stream</span>
        <span className="truncate text-l-brass/80">{runtime}</span>
      </div>

      <div className="border-b border-l-line px-4 py-3 font-mono text-[12px] leading-relaxed">
        <div className="flex min-w-0 gap-2">
          <span className="shrink-0 text-l-accent crt-glow">{script.request.method}</span>
          <span className="truncate text-l-text">{script.request.target}</span>
        </div>
        {script.request.body && (
          <div className="truncate text-l-faint" title={script.request.body}>
            {script.request.body}
          </div>
        )}
        <div className="mt-2 flex min-w-0 items-center justify-between gap-3 text-[10.5px]">
          <span className="truncate text-l-muted">{script.response}</span>
          <span className="hidden shrink-0 text-l-faint sm:inline">{script.wire}</span>
        </div>
      </div>

      <ol
        className="flex-1 space-y-0.5 px-4 py-3 font-mono text-[11.5px] leading-[1.6]"
        aria-label="Streamed events"
      >
        {visible.map((event, index) => (
          <m.li
            key={`${index}-${event.label}`}
            initial={reduced ? false : { opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="grid min-w-0 grid-cols-[minmax(0,11.5rem)_minmax(0,1fr)] gap-3"
          >
            <span className={cx('truncate', LABEL_TONE[event.tone])}>{event.label}</span>
            {event.value && <span className="truncate text-l-muted">{event.value}</span>}
          </m.li>
        ))}
      </ol>

      <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-l-line px-4 py-3">
        <p className="min-w-0 text-[13px] text-l-text">
          <span className="mr-2 font-mono text-[11px] text-l-faint">assistant ›</span>
          {answer}
          {!done && <span className="crt-cursor ml-0.5" aria-hidden />}
        </p>
        {done && <Vox tone="accent">transmission complete</Vox>}
      </div>
    </div>
  );
}
