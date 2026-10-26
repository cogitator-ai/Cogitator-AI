'use client';

import { ArrowRight, Check, Circle, ShieldQuestion, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, cx } from '../../../ui';
import { Chip, DemoFrame, Reveal, Typed, useDemoTimeline } from './shared';

const DURATIONS = [900, 1200, 1100, 1200, 1600, 1100, 1300, 3000];
const APPROVAL_STEP = 4;
const DONE_STEP = 7;

interface Todo {
  content: string;
  /** The step at which the todo turns in_progress. */
  from: number;
  /** The step at which it is completed. */
  until: number;
}

const TODOS: Todo[] = [
  { content: 'find the test', from: 1, until: 3 },
  { content: 'fix add()', from: 3, until: 5 },
  { content: 'run the tests', from: 5, until: 7 },
];

const READS = [
  { call: 'glob("**/*.test.ts")', result: 'src/math.test.ts' },
  { call: 'grep("add\\(")', result: 'src/math.ts:1' },
  { call: 'read_file("src/math.ts")', result: 'a - b' },
] as const;

function TodoChip({ todo, step }: { todo: Todo; step: number }) {
  if (step >= todo.until) {
    return (
      <Chip tone="accent">
        <Check className="size-3" /> {todo.content}
      </Chip>
    );
  }
  if (step >= todo.from) {
    return (
      <Chip tone="info">
        <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-l-info" />{' '}
        {todo.content}
      </Chip>
    );
  }
  return (
    <Chip>
      <Circle className="size-2.5 text-l-faint" /> {todo.content}
    </Chip>
  );
}

function Call({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] leading-[1.6]">
      <Wrench className="size-3 shrink-0 text-l-violet" />
      <span className="min-w-0 flex-1 truncate text-l-text">{children}</span>
      {aside}
    </div>
  );
}

function Result({ children }: { children: ReactNode }) {
  return (
    <span className="text-l-accent">
      <ArrowRight className="mx-1 inline size-3 align-[-2px] text-l-faint" />
      {children}
    </span>
  );
}

function Status({ step }: { step: number }) {
  if (step >= DONE_STEP) return <Badge tone="accent">completed</Badge>;
  if (step === APPROVAL_STEP) return <Badge tone="warn">awaiting approval</Badge>;
  return (
    <Badge tone="info">
      <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-l-info" /> running
    </Badge>
  );
}

/** A coding run of the harness agent: plan, parallel reads, an approved edit, the tests, done. */
export function HarnessDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;

  return (
    <DemoFrame
      timeline={timeline}
      label="cog.run · coder · default mode"
      aside={
        <span className="hidden sm:inline-flex">
          <Status step={step} />
        </span>
      }
    >
      <div className="space-y-1.5 text-[12.5px] leading-relaxed">
        <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm bg-white/[0.06] px-3 py-1 text-l-text">
          The add() test fails, fix it
        </div>

        <Reveal show={step >= 1} className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 flex items-center gap-2 font-mono text-[11px] text-l-muted">
            <Wrench className="size-3 shrink-0 text-l-violet" />
            write_todos
          </span>
          {TODOS.map((todo) => (
            <TodoChip key={todo.content} todo={todo} step={step} />
          ))}
        </Reveal>

        <Reveal
          show={step >= 2}
          className="flex items-center gap-3 rounded-lg border border-l-line bg-l-raised px-3 py-1.5"
        >
          <div className="min-w-0 flex-1">
            {READS.map((read) => (
              <Call
                key={read.call}
                aside={
                  step < 3 && (
                    <span className="size-1.5 shrink-0 motion-safe:animate-pulse rounded-full bg-l-info" />
                  )
                }
              >
                {read.call}
                {step >= 3 && <Result>{read.result}</Result>}
              </Call>
            ))}
          </div>
          <Chip tone="brass" className="shrink-0">
            parallel<span className="hidden sm:inline"> · read-only</span>
          </Chip>
        </Reveal>

        <Reveal show={step >= APPROVAL_STEP}>
          <Call
            aside={
              step > APPROVAL_STEP ? (
                <Chip tone="accent" className="shrink-0">
                  <Check className="size-3" /> approved
                </Chip>
              ) : (
                <Chip tone="warn" className="shrink-0">
                  <ShieldQuestion className="size-3" /> ask · onApproval
                </Chip>
              )
            }
          >
            edit_file(&quot;src/math.ts&quot;){' '}
            <span className={cx('text-l-danger/80', step > APPROVAL_STEP && 'line-through')}>
              a - b
            </span>
            <Result>a + b</Result>
          </Call>
        </Reveal>

        <Reveal show={step >= 6}>
          <Call
            aside={
              <Chip className="shrink-0">
                allow<span className="hidden sm:inline"> · Bash(pnpm test *)</span>
              </Chip>
            }
          >
            run_command(&quot;pnpm test&quot;)
            <Result>exit 0 · passed</Result>
          </Call>
        </Reveal>

        <Reveal show={step >= DONE_STEP}>
          <div className="text-l-text">
            <span className="mr-2 font-mono text-[10.5px] text-l-faint">coder</span>
            <Typed
              text="add() subtracted instead of adding. Fixed it in src/math.ts, and the tests pass."
              play={step === DONE_STEP}
            />
          </div>
        </Reveal>
      </div>
    </DemoFrame>
  );
}
