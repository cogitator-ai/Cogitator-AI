'use client';

import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import { Check, Pause, Play, RotateCcw, ShieldCheck, Wrench } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Vox, cx } from './ui';

const STEP_DURATIONS = [900, 1300, 1300, 1500, 1300, 1200, 1100, 2200, 3200];
const FINAL_STEP = STEP_DURATIONS.length - 1;

type Status = 'running' | 'paused' | 'completed';

function statusAt(step: number): Status {
  if (step >= 7) return 'completed';
  if (step >= 3 && step < 5) return 'paused';
  return 'running';
}

function useRunTimeline(active: boolean, reduced: boolean): number {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(FINAL_STEP);
      return;
    }
    if (!active) return;
    const timer = setTimeout(
      () => setStep((current) => (current >= FINAL_STEP ? 0 : current + 1)),
      STEP_DURATIONS[step]
    );
    return () => clearTimeout(timer);
  }, [active, reduced, step]);

  return step;
}

function Streamed({ text, play }: { text: string; play: boolean }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);

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
        return count + 2;
      });
    }, 18);
    return () => clearInterval(interval);
  }, [play, reduced, text]);

  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="crt-cursor ml-0.5" />}
    </>
  );
}

function Row({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const statusBadge: Record<Status, ReactNode> = {
  running: (
    <Badge tone="info">
      <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> running
    </Badge>
  ),
  paused: (
    <Badge tone="warn">
      <Pause className="size-2.5" /> paused
    </Badge>
  ),
  completed: (
    <Badge tone="accent">
      <Check className="size-2.5" /> completed
    </Badge>
  ),
};

/** A replay of examples/core/14-approvals.ts: a large refund pauses for a human and resumes. */
export function HeroRun() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-80px' });
  const reduced = useReducedMotion() ?? false;
  const step = useRunTimeline(inView, reduced);
  const status = statusAt(step);

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-l-line px-4 py-2.5">
        <span className="font-mono text-[11px] text-l-faint">run · ticket-7731</span>
        {statusBadge[status]}
      </div>

      <div className="flex-1 space-y-3 px-4 py-4 text-[13px] leading-relaxed">
        <Row show={step >= 0}>
          <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm bg-white/[0.06] px-3 py-2 text-l-text">
            Order A-1001 arrived broken, please refund all $340.
          </div>
        </Row>

        <Row show={step >= 1}>
          <div className="text-l-muted">
            <Streamed text="Sorry about that — issuing the refund now." play={step === 1} />
          </div>
        </Row>

        <Row show={step >= 2}>
          <div className="rounded-lg border border-l-line bg-l-raised px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-mono text-xs text-l-text">
                <Wrench className="size-3.5 text-l-violet" />
                refund_order
              </span>
              <span className="font-mono text-[10.5px] text-l-warn">
                amount &gt; 100 → needs approval
              </span>
            </div>
            <div className="mt-1.5 font-mono text-[11.5px] text-l-muted">
              {'{ order: "A-1001", amount: 340 }'}
            </div>
          </div>
        </Row>

        <Row show={step >= 3}>
          <div
            className={cx(
              'rounded-lg border px-3 py-2.5 transition-colors duration-500',
              step < 5 ? 'border-l-warn/30 bg-l-warn/[0.05]' : 'border-l-line bg-transparent'
            )}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="flex items-center gap-2 text-xs text-l-text">
                <ShieldCheck className="size-3.5 text-l-warn" />
                Waiting for a manager
              </span>
              <Vox tone="brass">checkpoint enshrined</Vox>
              <div className="ml-auto flex gap-1.5">
                <span className="rounded-md border border-l-line px-2 py-0.5 text-[11px] text-l-faint">
                  Decline
                </span>
                <motion.span
                  animate={step === 5 ? { scale: [1, 0.94, 1] } : { scale: 1 }}
                  transition={{ duration: 0.35 }}
                  className={cx(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                    step >= 5 ? 'bg-l-accent text-l-bg' : 'bg-l-text/90 text-l-bg'
                  )}
                >
                  {step >= 5 ? 'Approved' : 'Approve'}
                </motion.span>
              </div>
            </div>
          </div>
        </Row>

        <Row show={step >= 4}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-l-faint">
            <RotateCcw className="size-3 text-l-brass" />
            worker restarted
            <Vox tone="accent">machine spirit restored</Vox>
          </div>
        </Row>

        <Row show={step >= 6}>
          <div className="flex items-center gap-2 font-mono text-[11.5px] text-l-muted">
            <Play className="size-3 text-l-accent" />
            refund_order → <span className="text-l-accent">{'{ refunded: 340 }'}</span>
          </div>
        </Row>

        <Row show={step >= 7}>
          <div className="text-l-text">
            <Streamed
              text="Done — $340 is on its way back to your card. It usually lands in 3–5 days."
              play={step === 7}
            />
          </div>
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-l-line px-4 py-2.5 font-mono text-[10.5px] text-l-faint">
        <span>claude-sonnet-5-5</span>
        <span>{step >= 7 ? '1,184' : step >= 2 ? '612' : '208'} tokens</span>
        <span>{step >= 7 ? '$0.0041' : '$0.0019'}</span>
        <span className="ml-auto">trace · 6 spans</span>
      </div>
    </div>
  );
}
