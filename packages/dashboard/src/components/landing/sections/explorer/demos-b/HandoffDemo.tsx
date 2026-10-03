'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Wrench } from 'lucide-react';
import { Badge, Vox, cx } from '../../../ui';
import { DemoFrame, Reveal, Typed, useDemoTimeline } from './shared';

const DURATIONS = [1000, 1200, 1300, 1300, 1700, 2800];
const AGENTS = ['triage', 'billing', 'tech_support'] as const;

function AgentRail({ active }: { active: (typeof AGENTS)[number] }) {
  return (
    <div className="relative isolate flex items-center gap-1.5">
      {AGENTS.map((agent) => (
        <span
          key={agent}
          className={cx(
            'relative rounded-md border px-2 py-0.5 font-mono text-[10.5px] leading-4 transition-colors duration-500',
            agent === active ? 'border-l-accent/30 text-l-text' : 'border-l-line text-l-faint'
          )}
        >
          {agent === active && (
            <motion.span
              layoutId="handoff-active"
              className="absolute inset-0 -z-10 rounded-md bg-l-accent/[0.07]"
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            />
          )}
          {agent}
        </span>
      ))}
    </div>
  );
}

/** A triage agent passes the conversation to the billing specialist, who answers it. */
export function HandoffDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;
  const active = step >= 2 ? 'billing' : 'triage';

  return (
    <DemoFrame
      timeline={timeline}
      label={<AgentRail active={active} />}
      aside={
        <span className="hidden sm:inline-flex">
          {step >= 5 ? (
            <Badge tone="accent">completed</Badge>
          ) : (
            <Badge tone="info">
              <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> running
            </Badge>
          )}
        </span>
      }
      footer={
        <>
          <span>
            finalAgent{' '}
            <span className={step >= 5 ? 'text-l-text' : ''}>{step >= 5 ? '"billing"' : '—'}</span>
          </span>
          <span>handoffs {step >= 2 ? 1 : 0}</span>
          {step >= 5 && <Vox className="ml-auto">conversation transferred</Vox>}
        </>
      }
    >
      <div className="space-y-2 text-[12.5px] leading-relaxed">
        <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm bg-white/[0.06] px-3 py-1.5 text-l-text">
          How much do I owe on invoice INV-204?
        </div>

        <Reveal show={step >= 1}>
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-l-muted">
            <span className="text-l-faint">triage</span>
            <Wrench className="size-3 shrink-0 text-l-violet" />
            <span className="truncate">transfer_to_billing</span>
          </div>
        </Reveal>

        <Reveal show={step >= 2}>
          <div className="flex items-center gap-2">
            <span className="h-px flex-1 bg-l-brass/25" />
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-l-brass">
              agent.handoff · triage <ArrowRight className="size-3" /> billing
            </span>
            <span className="h-px flex-1 bg-l-brass/25" />
          </div>
        </Reveal>

        <Reveal show={step >= 3}>
          <div className="rounded-lg border border-l-line bg-l-raised px-3 py-1.5 font-mono text-[11px] leading-[1.6]">
            <div className="flex min-w-0 items-center gap-2 text-l-text">
              <Wrench className="size-3 shrink-0 text-l-violet" />
              <span className="truncate">lookup_invoice({'{ invoice: "INV-204" }'})</span>
            </div>
            <div className="pl-5 text-l-accent">{'{ amount: 129, status: "due" }'}</div>
          </div>
        </Reveal>

        <Reveal show={step >= 4}>
          <div className="text-l-text">
            <span className="mr-2 font-mono text-[10.5px] text-l-faint">billing</span>
            <Typed text="You owe $129 on INV-204, and it's still due." play={step === 4} />
          </div>
        </Reveal>
      </div>
    </DemoFrame>
  );
}
