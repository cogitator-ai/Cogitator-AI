'use client';

import { m } from 'framer-motion';
import { Server } from 'lucide-react';
import { cx, Vox } from '../../../ui';
import { DemoBar, EASE, Streamed, useDemoTimeline } from './shared';

type Direction = 'request' | 'response';

interface Exchange {
  direction: Direction;
  method: string;
  detail: string;
  tone?: 'info' | 'accent' | 'warn';
}

const EXCHANGES: Exchange[] = [
  { direction: 'request', method: 'GET', detail: '/.well-known/agent.json' },
  { direction: 'response', method: 'AgentCard', detail: 'researcher · streaming' },
  { direction: 'request', method: 'message/stream', detail: '"Summarize Q3 churn"' },
  { direction: 'response', method: 'status-update', detail: 'working', tone: 'info' },
  { direction: 'response', method: 'artifact-update', detail: 'text/plain', tone: 'warn' },
  { direction: 'response', method: 'status-update', detail: 'completed', tone: 'accent' },
];

const TONES = {
  info: 'text-l-info',
  accent: 'text-l-accent',
  warn: 'text-l-warn',
} as const;

const ARTIFACT =
  'Churn rose 2.1 pts in Q3, mostly annual plans that renewed after the June price change.';

const DURATIONS = [900, 1000, 1000, 900, 2400, 3400] as const;

function Arrow({ direction, active }: { direction: Direction; active: boolean }) {
  const toRight = direction === 'request';
  return (
    <div className="relative h-px w-full">
      <m.span
        className={cx(
          'absolute inset-y-0 h-px transition-colors duration-500',
          toRight ? 'left-0' : 'right-0',
          active ? 'bg-l-accent/70' : 'bg-white/20'
        )}
        initial={{ width: '0%' }}
        animate={{ width: '100%' }}
        transition={{ duration: 0.45, ease: EASE }}
      />
      <m.span
        aria-hidden
        className={cx(
          'absolute -top-[3px] size-0 border-y-[3.5px] border-y-transparent transition-colors duration-500',
          toRight ? 'right-0 border-l-[6px]' : 'left-0 border-r-[6px]',
          toRight
            ? active
              ? 'border-l-l-accent/70'
              : 'border-l-white/25'
            : active
              ? 'border-r-l-accent/70'
              : 'border-r-white/25'
        )}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.2 }}
      />
    </div>
  );
}

function Host({ name, agent, align }: { name: string; agent: string; align: 'left' | 'right' }) {
  return (
    <div className={cx('min-w-0', align === 'right' && 'text-right')}>
      <div
        className={cx(
          'flex items-center gap-1.5 text-[12px] text-l-text',
          align === 'right' && 'justify-end'
        )}
      >
        <Server className="size-3 shrink-0 text-l-brass" />
        <span className="truncate">{agent}</span>
      </div>
      <div className="truncate font-mono text-[10px] text-l-faint">{name}</div>
    </div>
  );
}

/** An orchestrator on one server discovering and streaming from a researcher on another. */
export function A2aDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const state = step >= 5 ? 'completed' : step >= 3 ? 'working' : 'discovering';

  return (
    <div ref={ref} className="flex h-full flex-col">
      <DemoBar
        label="A2A v0.3 · JSON-RPC"
        right={
          <span className="font-mono text-[10.5px] text-l-faint">
            task_8f2c ·{' '}
            <span
              className={
                state === 'completed' ? 'text-l-accent' : state === 'working' ? 'text-l-info' : ''
              }
            >
              {state}
            </span>
          </span>
        }
      />

      <div className="flex items-start justify-between gap-4 px-4 pt-2.5 sm:px-6">
        <Host agent="orchestrator" name="ops.internal · A2AClient" align="left" />
        <Host agent="researcher" name="research.internal · A2AServer" align="right" />
      </div>

      <div className="relative min-h-0 flex-1 px-4 py-1.5 sm:px-6">
        <span
          aria-hidden
          className="absolute bottom-1.5 left-[22px] top-0 w-px bg-l-brass/25 sm:left-[30px]"
        />
        <span
          aria-hidden
          className="absolute bottom-1.5 right-[22px] top-0 w-px bg-l-brass/25 sm:right-[30px]"
        />

        <ol className="relative space-y-[5px] px-3 sm:px-4">
          {EXCHANGES.map((exchange, index) => (
            <li key={`${exchange.method}-${index}`} className="h-[22px]">
              {index <= step && (
                <m.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25 }}
                  className="flex h-full flex-col justify-end gap-1 [&>*]:shrink-0"
                >
                  <div
                    className={cx(
                      'flex items-baseline gap-2 font-mono text-[10.5px] leading-[14px] sm:text-[11px]',
                      exchange.direction === 'response' && 'justify-end'
                    )}
                  >
                    <span className="shrink-0 text-l-muted">{exchange.method}</span>
                    <span
                      className={cx(
                        'truncate',
                        exchange.tone ? TONES[exchange.tone] : 'text-l-faint'
                      )}
                    >
                      {exchange.detail}
                    </span>
                  </div>
                  <Arrow direction={exchange.direction} active={index === step} />
                </m.div>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="h-[54px] shrink-0 border-t border-l-line px-4 py-2 sm:px-6">
        {step >= 5 ? (
          <div>
            <p className="line-clamp-1 text-[12px] leading-[18px] text-l-text">{ARTIFACT}</p>
            <Vox className="mt-0.5 block">transmission complete</Vox>
          </div>
        ) : step === 4 ? (
          <p className="line-clamp-2 text-[12px] leading-[18px] text-l-text">
            <Streamed text={ARTIFACT} play />
          </p>
        ) : (
          <p className="font-mono text-[10.5px] leading-[18px] text-l-faint">
            The remote side can be any A2A agent: LangChain, CrewAI or another Cogitator.
          </p>
        )}
      </div>
    </div>
  );
}
