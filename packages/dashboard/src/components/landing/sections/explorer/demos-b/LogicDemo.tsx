'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { Badge, Vox, cx } from '../../../ui';
import { DemoFrame, EASE, Reveal, Typed, useDemoTimeline } from './shared';

const DURATIONS = [1300, 1000, 1000, 1000, 2400, 1300, 1000, 1000, 3000];

const PROGRAM = [
  'role(ann, admin).  role(bob, support).',
  'grants(admin, refund).  grants(support, read).',
  'can(User, Action) :- role(User, Role), grants(Role, Action).',
];

interface Goal {
  goal: string;
  ok: boolean;
  binding: string;
}

interface Query {
  text: string;
  start: number;
  goals: [Goal, Goal];
  answer: string;
  proved: boolean;
}

const QUERIES: [Query, Query] = [
  {
    text: 'can(bob, refund).',
    start: 0,
    goals: [
      { goal: 'role(bob, Role)', ok: true, binding: 'Role = support' },
      { goal: 'grants(support, refund)', ok: false, binding: 'no clause matches' },
    ],
    answer: 'false.',
    proved: false,
  },
  {
    text: 'can(ann, Action).',
    start: 5,
    goals: [
      { goal: 'role(ann, Role)', ok: true, binding: 'Role = admin' },
      { goal: 'grants(admin, Action)', ok: true, binding: 'Action = refund' },
    ],
    answer: 'Action = refund.',
    proved: true,
  },
];

function ProofLine({ goal, last, show }: { goal: Goal; last: boolean; show: boolean }) {
  return (
    <Reveal show={show}>
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] leading-5">
        <span className="shrink-0 text-l-brass/70">{last ? '└─' : '├─'}</span>
        <span className="min-w-0 truncate text-l-muted">{goal.goal}</span>
        {goal.ok ? (
          <Check className="size-3 shrink-0 text-l-accent" />
        ) : (
          <X className="size-3 shrink-0 text-l-danger" />
        )}
        <span className={cx('shrink-0', goal.ok ? 'text-l-text' : 'text-l-faint')}>
          {goal.binding}
        </span>
      </div>
    </Reveal>
  );
}

/** Facts and a rule, then two queries proved (or refuted) goal by goal. */
export function LogicDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;
  const index = step >= QUERIES[1].start ? 1 : 0;
  const query = QUERIES[index];
  const local = step - query.start;
  const done = local >= 3;

  return (
    <DemoFrame
      timeline={timeline}
      label="query_logic · SLD resolution"
      aside={
        done ? (
          query.proved ? (
            <Badge tone="accent">proved</Badge>
          ) : (
            <Badge tone="danger">refuted</Badge>
          )
        ) : (
          <Badge tone="info">
            <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> resolving
          </Badge>
        )
      }
    >
      <pre className="whitespace-pre-wrap rounded-md border border-l-line bg-l-raised px-3 py-2 font-mono text-[10.5px] leading-[1.6] text-l-muted">
        {PROGRAM.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </pre>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={index}
          className="mt-3"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.35, ease: EASE }}
        >
          <div className="font-mono text-[11.5px] leading-5">
            <span className="crt-glow text-l-accent">?- </span>
            <span className="text-l-text">
              <Typed text={query.text} play={local === 0} speed={40} />
            </span>
          </div>
          <Reveal show={local >= 1}>
            <div className="font-mono text-[11px] leading-5 text-l-faint">
              can/2 :- role/2, grants/2
            </div>
          </Reveal>
          <ProofLine goal={query.goals[0]} last={false} show={local >= 1} />
          <ProofLine goal={query.goals[1]} last show={local >= 2} />
          <Reveal show={done} className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span
              className={cx(
                'font-mono text-[12px]',
                query.proved ? 'text-l-accent' : 'text-l-danger'
              )}
            >
              {query.answer}
            </span>
            {query.proved ? <Vox>proof complete</Vox> : <Vox tone="warn">no refund for bob</Vox>}
          </Reveal>
        </motion.div>
      </AnimatePresence>
    </DemoFrame>
  );
}
