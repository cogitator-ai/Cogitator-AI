import type { ReactNode } from 'react';

import { CogitatorFrame } from './CogitatorFrame';
import { cx } from './cx';

export { cx };

export function Section({
  id,
  children,
  className,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cx('relative px-5 sm:px-8 py-24 sm:py-32', className)}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-l-accent/90">{children}</p>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'left',
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  align?: 'left' | 'center';
}) {
  return (
    <div className={cx('max-w-2xl', align === 'center' && 'mx-auto text-center')}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-4 text-3xl sm:text-[2.6rem] font-semibold tracking-[-0.03em] leading-[1.08] text-l-text text-balance">
        {title}
      </h2>
      {description && (
        <p className="mt-5 text-base sm:text-lg leading-relaxed text-l-muted text-pretty">
          {description}
        </p>
      )}
    </div>
  );
}

/**
 * A window drawn as a cogitator terminal (see CogitatorFrame). `crt` marks live output: a phosphor
 * screen with the watermark; without it the screen is plain dark glass for code.
 */
export function Window({
  title,
  aside,
  children,
  className,
  bodyClassName,
  crt = false,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Render the body as a live phosphor screen. */
  crt?: boolean;
}) {
  return (
    <CogitatorFrame
      title={title}
      aside={aside}
      className={className}
      screenClassName={bodyClassName}
      variant={crt ? 'phosphor' : 'code'}
    >
      {children}
    </CogitatorFrame>
  );
}

export function CodeBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('landing-code overflow-x-auto px-5 py-4 text-[13px]', className)}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'danger' | 'info' | 'brass';
}) {
  const tones = {
    neutral: 'border-l-line-strong text-l-muted',
    brass: 'border-l-brass/30 text-l-brass bg-l-brass/[0.06]',
    accent: 'border-l-accent/30 text-l-accent bg-l-accent/[0.06]',
    warn: 'border-l-warn/30 text-l-warn bg-l-warn/[0.06]',
    danger: 'border-l-danger/30 text-l-danger bg-l-danger/[0.06]',
    info: 'border-l-info/30 text-l-info bg-l-info/[0.06]',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] leading-4',
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}

/**
 * A status line framed like a cogitator vox transmission: `+++ RUN PAUSED +++`.
 * Use for run/system states, sparingly — one or two per visual.
 */
export function Vox({
  children,
  tone = 'accent',
  className,
}: {
  children: ReactNode;
  tone?: 'accent' | 'warn' | 'brass' | 'muted';
  className?: string;
}) {
  const tones = {
    accent: 'text-l-accent crt-glow',
    warn: 'text-l-warn',
    brass: 'text-l-brass',
    muted: 'text-l-faint',
  } as const;
  return (
    <span
      className={cx(
        'font-mono text-[10.5px] uppercase tracking-[0.14em] whitespace-nowrap',
        tones[tone],
        className
      )}
    >
      +++ {children} +++
    </span>
  );
}
