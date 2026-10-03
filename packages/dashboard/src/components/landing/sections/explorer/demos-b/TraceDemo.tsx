'use client';

import { m } from 'framer-motion';
import { ArrowRight, Route } from 'lucide-react';
import { Badge, Vox, cx } from '../../../ui';
import { Chip, DemoFrame, EASE, Reveal, useDemoTimeline } from './shared';

const DURATIONS = [1000, 1300, 1000, 900, 1100, 900, 3000];
const TOTAL_MS = 2400;

interface SpanRow {
  name: string;
  kind: 'server' | 'client' | 'internal';
  start: number;
  end: number;
  meta: string;
  /** The step at which the span starts drawing. */
  from: number;
}

const SPANS: SpanRow[] = [
  { name: 'agent.run', kind: 'server', start: 0, end: 2400, meta: '2.4s', from: 2 },
  { name: 'llm.chat', kind: 'client', start: 40, end: 860, meta: '1,204 → 64 tok', from: 2 },
  { name: 'tool.get_order', kind: 'internal', start: 880, end: 1240, meta: '360ms', from: 3 },
  { name: 'llm.chat', kind: 'client', start: 1260, end: 2360, meta: '1,486 → 244 tok', from: 4 },
];

const BAR_TONE: Record<SpanRow['kind'], string> = {
  server: 'bg-l-brass/35',
  client: 'bg-l-info/55',
  internal: 'bg-l-violet/55',
};

function Waterfall({ step }: { step: number }) {
  return (
    <div className="space-y-1">
      {SPANS.map((span, index) => {
        const visible = step >= span.from;
        const done = span.name === 'agent.run' ? step >= 5 : step > span.from || step >= 5;
        const left = (span.start / TOTAL_MS) * 100;
        const width = ((span.end - span.start) / TOTAL_MS) * 100;
        return (
          <div
            key={`${span.name}-${index}`}
            className={cx(
              'grid grid-cols-[minmax(0,104px)_1fr] items-center gap-3 transition-opacity duration-300',
              visible ? 'opacity-100' : 'opacity-25'
            )}
          >
            <div className="min-w-0">
              <div
                className={cx(
                  'truncate font-mono text-[11px] leading-4',
                  index === 0 ? 'text-l-text' : 'pl-2.5 text-l-muted'
                )}
              >
                {span.name}
              </div>
              <div
                className={cx(
                  'truncate font-mono text-[9.5px] leading-3.5 text-l-faint',
                  index === 0 ? '' : 'pl-2.5'
                )}
              >
                {span.kind} · {done ? span.meta : '…'}
              </div>
            </div>
            <div className="relative h-4 rounded-sm bg-white/[0.025]">
              <m.div
                className={cx('absolute inset-y-0.5 rounded-sm', BAR_TONE[span.kind])}
                style={{ left: `${left}%` }}
                initial={false}
                animate={{ width: visible ? `${done ? width : width * 0.55}%` : '0%' }}
                transition={{ duration: visible ? 0.8 : 0.2, ease: EASE }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A traced run: cost routing picks a cheaper model, spans stream out to OTLP with tokens and cost. */
export function TraceDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;

  return (
    <DemoFrame
      timeline={timeline}
      label="trace · run_8f2c41"
      aside={
        step >= 5 ? (
          <Badge tone="accent">completed</Badge>
        ) : step >= 2 ? (
          <Badge tone="info">
            <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-l-info" /> running
          </Badge>
        ) : (
          <Badge tone="brass">routing</Badge>
        )
      }
      footer={
        <>
          <span>
            usage.cost{' '}
            <span className={step >= 5 ? 'text-l-text' : ''}>{step >= 5 ? '$0.00042' : '—'}</span>
          </span>
          <span>{step >= 5 ? '2,690 in · 308 out' : 'tokens —'}</span>
          <span className="ml-auto">4 spans</span>
        </>
      }
    >
      <div className="mb-3 rounded-lg border border-l-line px-3 py-2">
        <div className="flex items-center gap-2 font-mono text-[10.5px] text-l-faint">
          <Route className="size-3 text-l-brass" />
          costRouting · &quot;Where is my order A-1001?&quot;
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <span
            className={cx(
              'transition-colors',
              step >= 1 ? 'text-l-faint line-through' : 'text-l-muted'
            )}
          >
            claude-sonnet-5-5
          </span>
          <Reveal show={step >= 1} className="flex flex-wrap items-center gap-1.5">
            <ArrowRight className="size-3 text-l-faint" />
            <span className="crt-glow text-l-accent">gpt-6-luna</span>
            <Chip tone="brass">est. $0.0085 → $0.0004</Chip>
          </Reveal>
        </div>
      </div>

      <Waterfall step={step} />

      <Reveal
        show={step >= 6}
        className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-l-faint"
      >
        <Vox>transmission complete</Vox>
        <span>onSpan → otlp.exportSpan · /v1/traces</span>
      </Reveal>
    </DemoFrame>
  );
}
