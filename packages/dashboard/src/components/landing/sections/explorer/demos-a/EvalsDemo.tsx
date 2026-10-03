'use client';

import { motion } from 'framer-motion';
import { cx, Vox } from '../../../ui';
import { DemoBar, Reveal, useDemoTimeline } from './shared';

const CASES = 40;
const BATCH = 10;
const RUN_STEPS = CASES / BATCH;
const DURATIONS = [700, 700, 700, 700, 1300, 1300, 3600] as const;

/** `contains` failures per target: 28/40 vs 35/40, discordant pairs 1 vs 8 (McNemar p ≈ 0.046). */
const FAILS = {
  baseline: new Set([3, 7, 11, 14, 18, 21, 25, 28, 31, 34, 36, 39]),
  challenger: new Set([7, 18, 22, 28, 36]),
};

interface MetricRow {
  name: string;
  baseline: string;
  challenger: string;
  pValue: string;
  test: string;
  winner: 'challenger' | 'tie';
}

const METRICS: MetricRow[] = [
  {
    name: 'contains',
    baseline: '0.700',
    challenger: '0.875',
    pValue: '0.046',
    test: 'McNemar',
    winner: 'challenger',
  },
  {
    name: 'faithfulness',
    baseline: '0.84',
    challenger: '0.86',
    pValue: '0.38',
    test: 'paired t',
    winner: 'tie',
  },
];

function Cases({ target, done }: { target: keyof typeof FAILS; done: number }) {
  const passed = Array.from({ length: done }, (_, index) => index).filter(
    (index) => !FAILS[target].has(index)
  ).length;

  return (
    <div className="flex items-start gap-3">
      <span className="w-[72px] shrink-0 font-mono text-[10.5px] leading-[14px] text-l-muted">
        {target}
      </span>
      <div className="flex flex-1 flex-wrap gap-[3px] pt-[3px]">
        {Array.from({ length: CASES }, (_, index) => {
          const ran = index < done;
          const failed = FAILS[target].has(index);
          return (
            <motion.span
              key={index}
              initial={false}
              animate={{ scale: ran ? 1 : 0.7 }}
              transition={{ duration: 0.25, delay: ran ? (index % BATCH) * 0.03 : 0 }}
              className={cx(
                'size-2 rounded-[2px] transition-colors duration-300',
                !ran ? 'bg-white/[0.06]' : failed ? 'bg-l-danger/60' : 'bg-l-accent/70'
              )}
            />
          );
        })}
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-[10.5px] leading-[14px] text-l-faint">
        {passed}/{done}
      </span>
    </div>
  );
}

/** An A/B eval: two agents over the same 40 cases, then a significance test per metric. */
export function EvalsDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const done = Math.min(step + 1, RUN_STEPS) * BATCH;
  const shownMetrics = Math.max(0, step - (RUN_STEPS - 1));
  const finished = step >= RUN_STEPS + METRICS.length;

  return (
    <div ref={ref} className="flex h-full flex-col">
      <DemoBar
        label="EvalComparison · support.jsonl"
        right={
          <span className="font-mono text-[10.5px] text-l-faint">
            {done}/{CASES} cases
          </span>
        }
      />

      <div className="flex flex-1 flex-col gap-4 px-4 py-3.5">
        <div className="space-y-2.5">
          <Cases target="baseline" done={done} />
          <Cases target="challenger" done={done} />
        </div>

        <div className="overflow-hidden rounded-lg border border-l-line">
          <div className="grid grid-cols-[1.3fr_1fr_1fr_1.2fr] gap-2 border-b border-l-brass/20 bg-white/[0.02] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-l-brass/80">
            <span>metric</span>
            <span className="text-right">base</span>
            <span className="text-right">chall.</span>
            <span className="text-right">p-value</span>
          </div>
          {METRICS.map((metric, index) => (
            <div key={metric.name} className="h-[30px] border-b border-l-line last:border-b-0">
              <Reveal show={index < shownMetrics}>
                <div className="grid h-[30px] grid-cols-[1.3fr_1fr_1fr_1.2fr] items-center gap-2 px-3 font-mono text-[11px]">
                  <span className="truncate text-l-text">{metric.name}</span>
                  <span className="text-right text-l-muted">{metric.baseline}</span>
                  <span
                    className={cx(
                      'text-right',
                      metric.winner === 'challenger' ? 'text-l-accent' : 'text-l-muted'
                    )}
                  >
                    {metric.challenger}
                  </span>
                  <span className="truncate text-right text-l-faint">
                    <span className={metric.winner === 'challenger' ? 'text-l-text' : ''}>
                      {metric.pValue}
                    </span>
                    <span className="hidden sm:inline"> · {metric.test}</span>
                  </span>
                </div>
              </Reveal>
            </div>
          ))}
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-3 border-t border-l-line px-4 font-mono text-[10.5px] text-l-faint">
        {finished ? (
          <>
            <Vox>challenger prevails</Vox>
            <span className="ml-auto hidden truncate sm:inline">
              significant on contains · tie on faithfulness
            </span>
          </>
        ) : (
          <span>{step < RUN_STEPS ? 'running both targets…' : 'testing significance…'}</span>
        )}
      </div>
    </div>
  );
}
