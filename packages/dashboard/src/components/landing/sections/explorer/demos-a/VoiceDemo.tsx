'use client';

import { m } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import { cx, Vox } from '../../../ui';
import { DemoBar, Reveal, Streamed, useDemoTimeline } from './shared';

const DURATIONS = [1100, 1300, 900, 1500, 2000, 2600] as const;

const BAR_COUNT = 44;
const BARS = Array.from({ length: BAR_COUNT }, (_, index) => {
  const a = Math.abs(Math.sin(index * 1.7 + 0.4));
  const b = Math.abs(Math.sin(index * 0.83 + 2.1));
  return { low: 0.15 + a * 0.35, high: 0.35 + b * 0.65, period: 0.7 + (index % 5) * 0.12 };
});

const STAGES = ['VAD', 'STT', 'Agent', 'TTS'] as const;
/** Which pipeline stages are working at each step. */
const ACTIVE: readonly (readonly string[])[] = [
  ['VAD', 'STT'],
  ['VAD', 'STT'],
  ['STT', 'Agent'],
  ['Agent', 'TTS'],
  ['TTS'],
  [],
];

const EVENTS = [
  ['speech_start', 'transcript · interim'],
  ['transcript · interim'],
  ['speech_end', 'transcript · final'],
  ['agent_response'],
  ['audio'],
  ['turn_end'],
] as const;

const INTERIM = ['Can I move my', 'Can I move my cleaning to Friday'];
const FINAL = 'Can I move my cleaning to Friday morning?';
const REPLY = 'Sure, Friday at 9:00 is open. Want me to book it?';

function Waveform({ speaker }: { speaker: 'user' | 'agent' | null }) {
  return (
    <div className="flex h-12 items-center gap-[3px]" aria-hidden>
      {BARS.map((bar, index) => (
        <m.span
          key={index}
          className={cx(
            'h-full w-full max-w-[5px] flex-1 origin-center rounded-full transition-colors duration-500',
            speaker === 'agent'
              ? 'bg-l-accent/80'
              : speaker === 'user'
                ? 'bg-l-info/80'
                : 'bg-white/15'
          )}
          initial={false}
          animate={
            speaker
              ? { scaleY: [bar.low, bar.high, bar.low * 0.8, bar.high * 0.7, bar.low] }
              : { scaleY: 0.06 }
          }
          transition={
            speaker
              ? { duration: bar.period, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 0.4 }
          }
        />
      ))}
    </div>
  );
}

/** A voice turn through the pipeline: speech in, transcript, agent reply, speech out. */
export function VoiceDemo() {
  const { ref, step, reduced } = useDemoTimeline(DURATIONS);
  const speaker = reduced ? null : step <= 1 ? 'user' : step === 4 ? 'agent' : null;
  const active = ACTIVE[step];

  return (
    <div ref={ref} className="flex h-full flex-col">
      <DemoBar
        label="VoiceAgent · pipeline · ws://localhost:8080/voice"
        right={
          speaker === 'agent' ? (
            <Vox>vox transmitting</Vox>
          ) : step <= 1 ? (
            <Vox tone="muted">listening</Vox>
          ) : null
        }
      />

      <div className="flex flex-1 flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="w-9 shrink-0 font-mono text-[10.5px] text-l-faint">
            {speaker === 'agent' ? 'agent' : 'you'}
          </span>
          <Waveform speaker={speaker} />
        </div>

        <div className="flex items-center gap-1">
          {STAGES.map((stage, index) => (
            <Fragment key={stage}>
              {index > 0 && <ChevronRight className="size-3 shrink-0 text-l-brass/50" />}
              <span
                className={cx(
                  'flex-1 rounded-md border px-1 py-1 text-center font-mono text-[10.5px] transition-colors duration-300',
                  active.includes(stage)
                    ? 'border-l-accent/40 bg-l-accent/[0.07] text-l-accent'
                    : 'border-l-brass/20 text-l-faint'
                )}
              >
                {stage}
              </span>
            </Fragment>
          ))}
        </div>

        <div className="space-y-2 text-[12.5px] leading-snug">
          <p className="flex gap-2">
            <span className="w-9 shrink-0 font-mono text-[10.5px] leading-5 text-l-faint">you</span>
            <span className={step >= 2 ? 'text-l-text' : 'italic text-l-muted'}>
              {step >= 2 ? FINAL : `${INTERIM[step]}…`}
            </span>
          </p>
          <Reveal show={step >= 3}>
            <p className="flex gap-2">
              <span className="w-9 shrink-0 font-mono text-[10.5px] leading-5 text-l-faint">
                agent
              </span>
              <span className="text-l-text">
                <Streamed text={REPLY} play={step === 3} />
              </span>
            </p>
          </Reveal>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-hidden border-t border-l-line px-4 py-2.5 font-mono text-[10.5px]">
        <span className="shrink-0 text-l-brass/70">events</span>
        {EVENTS[step].map((event) => (
          <m.span
            key={`${step}-${event}`}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            className="shrink-0 rounded border border-l-line px-1.5 text-l-muted"
          >
            {event}
          </m.span>
        ))}
      </div>
    </div>
  );
}
