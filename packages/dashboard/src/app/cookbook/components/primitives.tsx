'use client';

import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react';
import { Info, Lightbulb, TriangleAlert } from 'lucide-react';
import { cx } from '@/components/landing/ui';
import type { Difficulty, RecipeNote } from '../recipes';

export type OpenTarget = (id: string) => void;

/** Plain text where spans in backticks render as inline code. */
export function InlineText({ text }: { text: string }) {
  const parts = text.split('`');
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={index}
            className="rounded border border-l-brass/15 bg-white/[0.04] px-1 py-px font-mono text-[0.86em] text-[#c6e6da] [overflow-wrap:anywhere]"
          >
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

/**
 * A real link to a cookbook hash route. Plain clicks route in place; modified clicks (new tab,
 * new window) keep the browser's default behaviour.
 */
export function HashLink({
  to,
  onOpen,
  onClick,
  ...props
}: { to: string; onOpen: OpenTarget } & Omit<ComponentPropsWithoutRef<'a'>, 'href'>) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onOpen(to);
  };

  return <a href={`#${to}`} onClick={handleClick} {...props} />;
}

const levels: Record<Difficulty, number> = { easy: 1, medium: 2, advanced: 3 };

/** Difficulty as a three-lamp brass gauge with its name beside it. */
export function DifficultyGauge({ level }: { level: Difficulty }) {
  const lit = levels[level];
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex items-end gap-[3px]" aria-hidden>
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            className={cx(
              'w-[5px] rounded-[1px]',
              step === 1 ? 'h-2' : step === 2 ? 'h-2.5' : 'h-3',
              step <= lit ? 'bg-l-brass shadow-[0_0_6px_rgb(201_164_92/0.45)]' : 'bg-white/[0.09]'
            )}
          />
        ))}
      </span>
      <span className="font-[family-name:var(--font-screen)] text-[11.5px] uppercase tracking-[0.12em] text-l-muted">
        {level}
      </span>
    </span>
  );
}

export function SubHeading({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2
      id={id}
      className="imperial mb-4 mt-12 text-[1.3rem] font-semibold leading-snug text-l-text sm:text-[1.5rem]"
    >
      {children}
    </h2>
  );
}

export function MinorHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="imperial mb-3 mt-8 text-[1.08rem] font-semibold leading-snug text-l-text">
      {children}
    </h3>
  );
}

/** A list with riveted brass diamonds for bullets. */
export function PointList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2.5 text-[15px] leading-relaxed text-l-muted">
      {items.map((item) => (
        <li key={item} className="relative pl-6">
          <span
            aria-hidden
            className="absolute left-1 top-[0.62em] size-[7px] rotate-45 border border-l-brass/70 bg-[radial-gradient(circle,#c9a45c_0_1px,#0d0c0a_1.5px)]"
          />
          <InlineText text={item} />
        </li>
      ))}
    </ul>
  );
}

const noteStyles = {
  info: {
    icon: Info,
    label: 'Note',
    text: 'text-l-brass',
    bar: 'bg-l-brass/70',
  },
  tip: {
    icon: Lightbulb,
    label: 'Tip',
    text: 'text-[#7fd4b5]',
    bar: 'bg-[#7fd4b5]/70',
  },
  warning: {
    icon: TriangleAlert,
    label: 'Caution',
    text: 'text-[#d8b26a]',
    bar: 'bg-[#ffb347]/70',
  },
} as const;

/** A recipe note on an iron plate, marked by its kind. */
export function Callout({ note }: { note: RecipeNote }) {
  const style = noteStyles[note.type];
  const Icon = style.icon;
  return (
    <aside className="iron-panel relative my-6 overflow-hidden rounded-lg border border-l-brass/20 py-3.5 pl-5 pr-4">
      <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[3px]', style.bar)} />
      <p
        className={cx(
          'flex items-center gap-2 font-[family-name:var(--font-screen)] text-[12px] uppercase tracking-[0.16em]',
          style.text
        )}
      >
        <Icon className="size-3.5" aria-hidden />
        {style.label}
      </p>
      <p className="mt-1.5 text-[15px] leading-relaxed text-l-text/90">
        <InlineText text={note.text} />
      </p>
    </aside>
  );
}
