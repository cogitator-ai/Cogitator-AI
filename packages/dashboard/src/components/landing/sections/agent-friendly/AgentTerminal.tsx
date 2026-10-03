'use client';

import { useInView, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Vox, Window, cx } from '../../ui';
import type { TerminalLine } from './types';
import { FINAL_HOLD_MS, PACE } from '../../pace';

const TYPE_START = 650;
const TYPE_STEP = 22;
const AFTER_TYPED = 420;
const FINAL_HOLD = 4200;

const STREAM_DELAY: Record<TerminalLine['kind'], number> = {
  agent: 0,
  command: 0,
  heading: 70,
  quote: 70,
  entry: 60,
  out: 55,
  note: 260,
  blank: 30,
  vox: 700,
};

const ROW = 'overflow-hidden text-ellipsis whitespace-pre';

function isTyped(line: TerminalLine): boolean {
  return line.kind === 'agent' || line.kind === 'command';
}

interface Progress {
  count: number;
  typed: number;
}

function useTerminal(lines: TerminalLine[], active: boolean, reduced: boolean): Progress {
  const [progress, setProgress] = useState<Progress>({ count: 0, typed: 0 });
  const total = lines.length;

  useEffect(() => {
    if (reduced) {
      setProgress({ count: total, typed: 0 });
      return;
    }
    if (!active) return;

    const { count, typed } = progress;
    const line = lines[count];
    let delay: number;
    let next: Progress;

    if (!line) {
      delay = Math.max(FINAL_HOLD * PACE, FINAL_HOLD_MS);
      next = { count: 0, typed: 0 };
    } else if (isTyped(line) && typed < line.text.length) {
      delay = (typed === 0 ? TYPE_START : TYPE_STEP) * 1.4;
      next = { count, typed: Math.min(line.text.length, typed + 2) };
    } else {
      delay = (isTyped(line) ? AFTER_TYPED : STREAM_DELAY[line.kind]) * PACE;
      next = { count: count + 1, typed: 0 };
    }

    const timer = setTimeout(() => setProgress(next), delay);
    return () => clearTimeout(timer);
  }, [active, reduced, progress, lines, total]);

  return progress;
}

function Heading({ text }: { text: string }) {
  const marks = /^#+/.exec(text)?.[0] ?? '';
  return (
    <>
      <span className="text-l-brass">{marks}</span>
      <span className="font-medium text-l-text">{text.slice(marks.length)}</span>
    </>
  );
}

function Line({ line, text, cursor }: { line: TerminalLine; text: string; cursor: boolean }) {
  const caret = cursor ? <span className="crt-cursor ml-0.5" aria-hidden /> : null;

  switch (line.kind) {
    case 'agent':
      return (
        <div className={cx(ROW, 'pt-1.5')}>
          <span className="text-l-accent crt-glow">agent ›</span>{' '}
          <span className="text-l-text">{text}</span>
          {caret}
        </div>
      );
    case 'command':
      return (
        <div className={ROW}>
          <span className="text-l-faint">$</span> <span className="text-l-text">{text}</span>
          {caret}
        </div>
      );
    case 'heading':
      return (
        <div className={ROW}>
          <Heading text={text} />
        </div>
      );
    case 'quote':
      return <div className={cx(ROW, 'text-l-muted')}>{text}</div>;
    case 'entry':
      return (
        <div
          className={cx(
            '-mx-2 rounded px-2',
            ROW,
            line.highlight && 'bg-l-accent/[0.07] shadow-[inset_2px_0_0_var(--color-l-accent)]'
          )}
        >
          <span className="text-l-faint">- [</span>
          <span className="text-l-text">{line.title}</span>
          <span className="text-l-faint">](</span>
          <span className="text-l-info/80">{line.url}</span>
          <span className="text-l-faint">)</span>
          {line.description && <span className="text-l-muted">: {line.description}</span>}
        </div>
      );
    case 'note':
      return <div className={cx(ROW, 'text-l-faint')}>{text}</div>;
    case 'vox':
      return (
        <div className="pt-1.5">
          <Vox tone="accent">{text}</Vox>
        </div>
      );
    case 'blank':
      return <div className="h-[1.6em]" aria-hidden />;
    case 'out':
      return <div className={cx(ROW, 'text-l-muted')}>{text}</div>;
  }
}

/** A coding agent reading llms.txt and then one docs page as Markdown, replayed in a loop. */
export function AgentTerminal({ lines }: { lines: TerminalLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-80px' });
  const reduced = useReducedMotion() ?? false;
  const { count, typed } = useTerminal(lines, inView, reduced);
  const current = lines[count];
  const typing = current && isTyped(current) ? current : undefined;
  const finished = count >= lines.length;

  return (
    <div ref={ref} className="min-w-0">
      <Window
        crt
        title="~/shop-api · agent session"
        aside={
          <span className="hidden font-mono text-[11px] text-l-brass/80 sm:inline">
            text/markdown
          </span>
        }
        bodyClassName="bg-l-bg/60"
      >
        <div
          className="flex h-[420px] flex-col justify-end overflow-hidden px-4 [&>*]:shrink-0 py-4 font-mono text-[11.5px] leading-[1.6] [mask-image:linear-gradient(to_bottom,transparent,black_16%)] sm:h-[460px] sm:px-5"
          aria-label="A coding agent fetching llms.txt and a docs page as Markdown"
          role="img"
        >
          {lines.slice(0, count).map((line, index) => (
            <Line
              key={index}
              line={line}
              text={line.text}
              cursor={finished && index === lines.length - 1}
            />
          ))}
          {typing && <Line line={typing} text={typing.text.slice(0, typed)} cursor />}
        </div>
      </Window>
    </div>
  );
}
