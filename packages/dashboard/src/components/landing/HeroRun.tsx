'use client';

import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import { Check, Pause, Play, RotateCcw, ShieldCheck, Wrench } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Vox, cx } from './ui';
import { paced } from './pace';

const STEP_DURATIONS = [900, 1300, 1300, 2600, 2400, 1200, 1100, 2200, 3200];
const FINAL_STEP = STEP_DURATIONS.length - 1;

type Status = 'running' | 'paused' | 'completed';

function statusAt(step: number): Status {
  if (step >= 7) return 'completed';
  if (step >= 3 && step < 5) return 'paused';
  return 'running';
}

function useRunTimeline(active: boolean, reduced: boolean) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(FINAL_STEP);
      return;
    }
    if (!active) return;
    const timer = setTimeout(
      () => setStep((current) => (current >= FINAL_STEP ? 0 : current + 1)),
      paced(STEP_DURATIONS, step)
    );
    return () => clearTimeout(timer);
  }, [active, reduced, step]);

  return { step, jump: setStep };
}

type Decision = 'approved' | 'declined';

/** The run waits on these steps; the approval buttons work only then. */
const AWAITING = new Set([3, 4]);

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
    }, 32);
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
  const { step, jump } = useRunTimeline(inView, reduced);
  const status = statusAt(step);
  const [decision, setDecision] = useState<Decision>('approved');
  const [skippedRestart, setSkippedRestart] = useState(false);
  const declined = decision === 'declined';
  const awaiting = AWAITING.has(step);

  useEffect(() => {
    if (step !== 0) return;
    setDecision('approved');
    setSkippedRestart(false);
  }, [step]);

  const decide = (next: Decision) => {
    setDecision(next);
    setSkippedRestart(step < 4);
    jump(5);
  };

  return (
    <div ref={ref} className="cog-text flex h-full flex-col text-[14px]">
      <div className="flex items-center justify-between border-b border-l-accent/10 px-4 py-2.5">
        <span className="text-[12px] tracking-[0.12em] text-l-accent/60">RUN · TICKET-7731</span>
        {statusBadge[status]}
      </div>

      <div className="flex-1 space-y-3 px-4 py-4 text-[13px] leading-relaxed">
        <Row show={step >= 0}>
          <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm border border-l-accent/20 bg-l-accent/[0.06] px-3 py-2 text-l-phosphor">
            Order A-1001 arrived broken, please refund all $340.
          </div>
        </Row>

        <Row show={step >= 1}>
          <div className="text-l-phosphor/75">
            <Streamed text="Sorry about that — issuing the refund now." play={step === 1} />
          </div>
        </Row>

        <Row show={step >= 2}>
          <div className="rounded-lg border border-l-brass/30 bg-black/30 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[13px] text-l-phosphor">
                <Wrench className="size-3.5 text-l-violet" />
                refund_order
              </span>
              <span className="font-mono text-[10.5px] text-l-warn">
                amount &gt; 100 → needs approval
              </span>
            </div>
            <div className="mt-1.5 text-[12.5px] text-l-phosphor/70">
              {'{ order: "A-1001", amount: 340 }'}
            </div>
          </div>
        </Row>

        <Row show={step >= 3}>
          <div
            className={cx(
              'rounded-lg border px-3 py-2.5 transition-colors duration-500',
              step < 5 ? 'border-l-warn/30 bg-l-warn/[0.05]' : 'border-l-accent/15 bg-transparent'
            )}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="flex items-center gap-2 text-[13px] text-l-phosphor">
                <ShieldCheck className="size-3.5 text-l-warn" />
                Waiting for a manager
              </span>
              <Vox tone="brass">checkpoint enshrined</Vox>
              <div className="ml-auto flex gap-1.5">
                {awaiting ? (
                  <>
                    <button
                      type="button"
                      onClick={() => decide('declined')}
                      className="cursor-pointer rounded-md border border-l-warn/40 px-2 py-0.5 text-[12px] text-l-warn/80 transition-colors hover:border-l-warn/70 hover:bg-l-warn/10 hover:text-l-warn"
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      onClick={() => decide('approved')}
                      className="cursor-pointer rounded-md border border-l-phosphor/45 bg-l-phosphor/[0.06] px-2 py-0.5 text-[12px] text-l-phosphor transition-colors hover:border-l-accent/70 hover:bg-l-accent/15"
                    >
                      Approve
                    </button>
                  </>
                ) : (
                  <motion.span
                    animate={step === 5 ? { scale: [1, 0.94, 1] } : { scale: 1 }}
                    transition={{ duration: 0.35 }}
                    className={cx(
                      'select-none rounded-md border px-2 py-0.5 text-[12px]',
                      step < 5
                        ? 'border-l-accent/15 text-l-accent/40'
                        : declined
                          ? 'border-l-warn/50 bg-l-warn/10 text-l-warn'
                          : 'border-l-accent/60 bg-l-accent/15 text-l-accent'
                    )}
                  >
                    {step < 5 ? 'awaiting' : declined ? 'Declined' : 'Approved'}
                  </motion.span>
                )}
              </div>
            </div>
          </div>
        </Row>

        <Row show={step >= 4 && !skippedRestart}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-l-accent/55">
            <RotateCcw className="size-3 text-l-brass" />
            worker restarted
            <Vox tone="accent">machine spirit restored</Vox>
          </div>
        </Row>

        <Row show={step >= 6}>
          {declined ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-l-phosphor/80">
              <Vox tone="warn">sanction denied</Vox>
              refund_order → <span className="text-l-warn">{'{ declined: "needs photos" }'}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[12.5px] text-l-phosphor/80">
              <Play className="size-3 text-l-accent" />
              refund_order → <span className="text-l-accent">{'{ refunded: 340 }'}</span>
            </div>
          )}
        </Row>

        <Row show={step >= 7}>
          <div className="text-l-phosphor">
            <Streamed
              key={decision}
              text={
                declined
                  ? "I can't refund the full $340 yet — refunds over $100 need photos of the damage. Could you send a couple?"
                  : 'Done — $340 is on its way back to your card. It usually lands in 3–5 days.'
              }
              play={step === 7}
            />
          </div>
        </Row>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-l-accent/10 px-4 py-2.5 text-[11.5px] text-l-accent/50">
        <span>claude-sonnet-5-5</span>
        <span>{step >= 7 ? '1,184' : step >= 2 ? '612' : '208'} tokens</span>
        <span>{step >= 7 ? '$0.0041' : '$0.0019'}</span>
        <span className="ml-auto">trace · 6 spans</span>
      </div>
    </div>
  );
}
