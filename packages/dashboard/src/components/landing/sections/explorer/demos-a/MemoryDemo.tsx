'use client';

import { m } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { cx, Vox } from '../../../ui';
import { DemoBar, EASE, Reveal, useDemoTimeline } from './shared';

const MAX_TOKENS = 8000;
const RESERVE = 800;
const USABLE = MAX_TOKENS - RESERVE;

interface Source {
  label: string;
  detail: string;
  tokens: number;
  swatch: string;
}

const SOURCES: Source[] = [
  {
    label: 'System prompt',
    detail: "You are Alice's travel concierge…",
    tokens: 210,
    swatch: 'bg-l-text/70',
  },
  { label: 'Known facts', detail: '3 facts for alice', tokens: 96, swatch: 'bg-l-violet' },
  { label: 'Relevant context', detail: 'top hits ≥ 0.70', tokens: 410, swatch: 'bg-l-info' },
  { label: 'Older, relevant', detail: '3 entries > 0.60', tokens: 1240, swatch: 'bg-l-warn' },
  { label: 'Recent', detail: 'last 10 entries', tokens: 4180, swatch: 'bg-l-accent' },
];

const HITS = [
  { score: '0.86', kept: true },
  { score: '0.74', kept: true },
  { score: '0.62', kept: false },
];

const DURATIONS = [700, 1000, 1500, 1100, 1100, 3400] as const;

function format(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

/** ContextBuilder filling an 8k budget: system prompt, facts, semantic hits, then history. */
export function MemoryDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const included = SOURCES.slice(0, Math.min(step + 1, SOURCES.length));
  const used = included.reduce((sum, source) => sum + source.tokens, 0);
  const done = step >= SOURCES.length;

  return (
    <div ref={ref} className="flex h-full flex-col">
      <DemoBar
        label="contextBuilder · strategy: hybrid"
        right={
          <span className="font-mono text-[11px] text-l-muted">
            <span className="text-l-text">{format(used)}</span> / {format(USABLE)} tok
          </span>
        }
      />

      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
        <div>
          <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-white/[0.04]">
            {SOURCES.map((source, index) => (
              <m.span
                key={source.label}
                className={cx(
                  'h-full shrink-0 rounded-[1px]',
                  index <= step && 'min-w-1',
                  source.swatch
                )}
                initial={false}
                animate={{
                  width: index <= step ? `${(source.tokens / MAX_TOKENS) * 100}%` : '0%',
                  opacity: index <= step ? 0.85 : 0,
                }}
                transition={{ duration: 0.6, ease: EASE }}
              />
            ))}
            <span className="flex-1" />
            <span
              className="h-full shrink-0 bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.16)_0_2px,transparent_2px_5px)]"
              style={{ width: `${(RESERVE / MAX_TOKENS) * 100}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-l-faint">
            <span>0</span>
            <span>reserve {format(RESERVE)} for the reply</span>
          </div>
        </div>

        <ul className="space-y-1.5">
          {SOURCES.map((source, index) => (
            <li key={source.label} className="h-[26px]">
              <Reveal show={index <= step}>
                <div className="flex h-[26px] items-center gap-2.5 text-[12.5px]">
                  <span className={cx('size-2 shrink-0 rounded-[2px]', source.swatch)} />
                  <span className="shrink-0 text-l-text">{source.label}</span>
                  <span className="hidden min-w-0 truncate text-l-faint sm:inline">
                    {source.detail}
                  </span>
                  {index === 2 && (
                    <span className="flex shrink-0 gap-1">
                      {HITS.map((hit) => (
                        <span
                          key={hit.score}
                          className={cx(
                            'inline-flex items-center gap-0.5 rounded border px-1 font-mono text-[10px] leading-4',
                            hit.kept
                              ? 'border-l-info/30 text-l-info'
                              : 'border-l-line text-l-faint line-through'
                          )}
                        >
                          {hit.kept ? <Check className="size-2.5" /> : <X className="size-2.5" />}
                          {hit.score}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-l-muted">
                    {format(source.tokens)}
                  </span>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-l-line px-4 py-2.5 font-mono text-[10.5px] text-l-faint">
        <span>13 of 58 entries</span>
        <span className="hidden text-l-brass/70 sm:inline">
          facts ≤ 10% · semantic ≤ 10% · older ≤ 30%
        </span>
        <span className="ml-auto">
          {done ? <Vox>context assembled</Vox> : <Vox tone="muted">assembling</Vox>}
        </span>
      </div>
    </div>
  );
}
