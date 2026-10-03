'use client';

import { motion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';
import { Badge, Vox, cx } from '../../../ui';
import { DemoFrame, EASE, Reveal, useDemoTimeline } from './shared';

const DURATIONS = [1100, 1100, 900, 900, 900, 1400, 1200, 3000];
const AB_STEP = 1;
const VERDICT_STEP = 5;
const PROMOTED_STEP = 6;

/** Runs per variant at each step of the test (70 / 30 split by thread). */
const SAMPLES = [
  { control: 0, treatment: 0 },
  { control: 0, treatment: 0 },
  { control: 38, treatment: 16 },
  { control: 79, treatment: 33 },
  { control: 117, treatment: 50 },
];

const RATES = { control: 0.78, treatment: 0.94 };

interface Version {
  version: number;
  text: string;
  note?: string;
}

const VERSIONS: Version[] = [
  { version: 1, text: 'You write release notes.' },
  { version: 2, text: 'You write release notes. Lead with what changed.' },
  {
    version: 3,
    text: 'You write release notes in at most five bullet points.',
    note: 'A/B winner',
  },
];

function VersionRow({ v, live, show }: { v: Version; live: boolean; show: boolean }) {
  return (
    <Reveal show={show}>
      <div
        className={cx(
          'flex min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-0.5 transition-colors duration-500',
          live ? 'border-l-accent/25 bg-l-accent/[0.04]' : 'border-transparent'
        )}
      >
        <span className={cx('font-mono text-[11px]', live ? 'text-l-accent' : 'text-l-faint')}>
          v{v.version}
        </span>
        <span
          className={cx(
            'min-w-0 flex-1 truncate text-[12px]',
            live ? 'text-l-text' : 'text-l-faint'
          )}
        >
          {v.text}
        </span>
        {v.note && (
          <span className="hidden font-mono text-[10px] text-l-brass sm:inline">{v.note}</span>
        )}
        {live && <span className="crt-glow font-mono text-[10px] text-l-accent">live</span>}
      </div>
    </Reveal>
  );
}

function VariantBar({
  name,
  share,
  runs,
  rate,
  winner,
}: {
  name: string;
  share: string;
  runs: number;
  rate: number;
  winner: boolean;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-2.5 font-mono text-[10.5px]">
      <span className={winner ? 'text-l-accent' : 'text-l-muted'}>
        {name} <span className="text-l-faint">{share}</span>
      </span>
      <div className="relative h-1.5 rounded-full bg-white/[0.06]">
        <motion.div
          className={cx(
            'absolute inset-y-0 left-0 rounded-full',
            winner ? 'bg-l-accent/70' : 'bg-l-info/50'
          )}
          initial={false}
          animate={{ width: `${(runs / 117) * 100}%` }}
          transition={{ duration: 0.7, ease: EASE }}
        />
      </div>
      <span className="w-[86px] text-right text-l-faint">
        {runs} runs ·{' '}
        <span className={winner ? 'text-l-accent' : 'text-l-muted'}>
          {runs ? `${Math.round(rate * 100)}%` : '—'}
        </span>
      </span>
    </div>
  );
}

/** Deploy instructions as versions, split traffic for an A/B test, promote the winner. */
export function PromptVersionsDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;
  const sample = SAMPLES[Math.min(step, SAMPLES.length - 1)] ?? SAMPLES[0];
  const promoted = step >= PROMOTED_STEP;
  const verdict = step >= VERDICT_STEP;

  return (
    <DemoFrame
      timeline={timeline}
      label="cog.prompts · writer"
      aside={
        promoted ? (
          <Badge tone="accent">v3 live</Badge>
        ) : step >= AB_STEP ? (
          <Badge tone="info">
            <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> A/B running
          </Badge>
        ) : (
          <Badge tone="neutral">v2 live</Badge>
        )
      }
      footer={
        <>
          <span>score: completed 1 · failed 0</span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <RotateCcw className="size-3 text-l-brass" />
            rollbackTo(writer) → {promoted ? 'v2' : 'v1'}
          </span>
        </>
      }
    >
      <div className="space-y-0.5">
        {VERSIONS.map((v) => (
          <VersionRow
            key={v.version}
            v={v}
            show={v.version < 3 || promoted}
            live={v.version === 3 ? promoted : v.version === 2 && !promoted}
          />
        ))}
      </div>

      <Reveal show={step >= AB_STEP} className="mt-3 rounded-lg border border-l-line px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-3 font-mono text-[10.5px] text-l-faint">
          <span className="truncate">startABTest · &quot;shorter notes&quot;</span>
          <span className="shrink-0">per thread</span>
        </div>
        <div className="space-y-1.5">
          <VariantBar
            name="control"
            share="70%"
            runs={sample.control}
            rate={RATES.control}
            winner={false}
          />
          <VariantBar
            name="treatment"
            share="30%"
            runs={sample.treatment}
            rate={RATES.treatment}
            winner={verdict}
          />
        </div>
        <div className="mt-2 min-h-4 font-mono text-[10.5px]">
          {verdict ? (
            <span className="text-l-muted">
              Welch t-test p = 0.002 <span className="text-l-faint">·</span>{' '}
              <span className="text-l-accent">treatment wins</span>
            </span>
          ) : (
            <span className="text-l-faint">collecting runs · minSampleSize 50</span>
          )}
        </div>
      </Reveal>

      <Reveal show={promoted} className="mt-2.5">
        <Vox>winner deployed · v3</Vox>
      </Reveal>
    </DemoFrame>
  );
}
