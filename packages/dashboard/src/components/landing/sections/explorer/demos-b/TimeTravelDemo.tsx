'use client';

import { m } from 'framer-motion';
import { Diamond, GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Vox, cx } from '../../../ui';
import { DemoFrame, EASE, Reveal, useDemoTimeline } from './shared';

const DURATIONS = [700, 700, 700, 900, 1300, 1100, 1100, 1000, 3000];
const CHECKPOINT_STEP = 4;
const DIFF_STEP = 8;

interface Call {
  tool: string;
  result: string;
  tone?: 'mocked' | 'diverged';
}

const ORIGINAL: Call[] = [
  { tool: 'find_supplier', result: 'Norsteel' },
  { tool: 'get_quote', result: '$612/t' },
  { tool: 'check_stock', result: 'iron: 40' },
  { tool: 'place_order', result: 'PO-3318' },
];

/** Fork calls by step index; steps 0–1 are shared with the original run. */
const FORK: Record<number, { call: Call; at: number }> = {
  2: { call: { tool: 'check_stock', result: 'iron: 0', tone: 'mocked' }, at: 5 },
  3: { call: { tool: 'find_supplier', result: 'Baltic Steel', tone: 'diverged' }, at: 6 },
  4: { call: { tool: 'place_order', result: 'PO-3319' }, at: 7 },
};

function CallCell({ call }: { call: Call }) {
  return (
    <div
      className={cx(
        'truncate rounded-md border px-2 py-0.5 font-mono text-[10.5px] leading-4',
        call.tone === 'diverged' ? 'border-l-warn/30 bg-l-warn/[0.05]' : 'border-l-line bg-l-raised'
      )}
    >
      <span className="text-l-text">{call.tool}</span>{' '}
      <span className={call.tone === 'mocked' ? 'text-l-brass' : 'text-l-faint'}>
        → {call.result}
        {call.tone === 'mocked' && ' (mocked)'}
      </span>
    </div>
  );
}

function Cell({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <Reveal show={show}>{children}</Reveal>
    </div>
  );
}

/** Checkpoint a finished run at step 2, fork it with a mocked tool result, see where it diverges. */
export function TimeTravelDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;
  const rows = [0, 1, 2, 3, 4];

  return (
    <DemoFrame
      timeline={timeline}
      label="timeTravel · trace_7c1e09"
      aside={
        step >= DIFF_STEP ? (
          <Badge tone="warn">diverged at step 3</Badge>
        ) : step >= CHECKPOINT_STEP + 1 ? (
          <Badge tone="info">
            <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-l-info" /> replaying
          </Badge>
        ) : (
          <Badge tone="neutral">original run</Badge>
        )
      }
      footer={
        step >= DIFF_STEP ? (
          <>
            <span>compare → divergencePoint 3</span>
            <span>tokens +412</span>
            <span className="ml-auto">fork.checkpoint ckpt_fork_…</span>
          </>
        ) : (
          <span>checkpoint(result, 2) · forkWithMockedTool(check_stock)</span>
        )
      }
    >
      <div className="grid grid-cols-[22px_minmax(0,1fr)_minmax(0,1fr)] gap-x-2 gap-y-1">
        <span />
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-l-faint">
          original
        </span>
        <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.1em] text-l-faint">
          <GitBranch className="size-3 text-l-brass" /> fork
        </span>

        {rows.map((row) => {
          const original = ORIGINAL[row];
          const fork = FORK[row];
          const isCheckpoint = row === 2;
          return (
            <div key={row} className="contents">
              <div className="flex items-center justify-center font-mono text-[10px] text-l-faint">
                {isCheckpoint && step >= CHECKPOINT_STEP ? (
                  <m.span
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.4, ease: EASE }}
                  >
                    <Diamond className="size-3 fill-l-brass/30 text-l-brass" />
                  </m.span>
                ) : (
                  row
                )}
              </div>
              <Cell show={original !== undefined && step >= row}>
                {original && <CallCell call={original} />}
              </Cell>
              {row < 2 ? (
                <Cell show={step >= CHECKPOINT_STEP + 1}>
                  <div className="truncate rounded-md border border-dashed border-l-line px-2 py-0.5 font-mono text-[10px] leading-4 text-l-faint">
                    from checkpoint
                  </div>
                </Cell>
              ) : (
                <Cell show={fork !== undefined && step >= fork.at}>
                  {fork && <CallCell call={fork.call} />}
                </Cell>
              )}
            </div>
          );
        })}
      </div>

      <Reveal show={step >= CHECKPOINT_STEP} className="mt-2.5">
        {step >= DIFF_STEP ? (
          <Vox tone="warn">timelines diverge</Vox>
        ) : (
          <Vox tone="brass">checkpoint enshrined · step 2</Vox>
        )}
      </Reveal>
    </DemoFrame>
  );
}
