import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { cx } from './ui';

type Lamp = 'green' | 'amber' | 'red' | 'off';

function Corner({ className }: { className: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      className={cx('pointer-events-none absolute size-7', className)}
      aria-hidden
    >
      <path
        d="M2 26V8a6 6 0 0 1 6-6h18"
        fill="none"
        stroke="#c9a45c"
        strokeOpacity="0.55"
        strokeWidth="3"
      />
      <path
        d="M2 26V8a6 6 0 0 1 6-6h18"
        fill="none"
        stroke="#0b0b0c"
        strokeOpacity="0.6"
        strokeWidth="0.8"
      />
      <circle
        cx="8"
        cy="8"
        r="1.8"
        fill="#8a6f3a"
        stroke="#e2c58c"
        strokeOpacity="0.5"
        strokeWidth="0.5"
      />
    </svg>
  );
}

function Lamps({ lamps }: { lamps: Lamp[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {lamps.map((lamp, index) => (
        <span key={index} className="cog-lamp" data-on={lamp === 'off' ? undefined : lamp} />
      ))}
    </div>
  );
}

/**
 * A cogitator terminal: riveted iron bezel with brass corners, a title plate with vents and
 * status lamps, and a phosphor screen (scanlines, vignette, faint watermark of the mark).
 */
export function CogitatorFrame({
  title,
  children,
  lamps = ['green', 'amber', 'off'],
  className,
  screenClassName,
  watermark = true,
  psalm,
}: {
  title: ReactNode;
  children: ReactNode;
  lamps?: Lamp[];
  className?: string;
  screenClassName?: string;
  watermark?: boolean;
  /** A line of "data psalm" (binary or hex noise) along the bottom of the screen. */
  psalm?: string;
}) {
  return (
    <div className={cx('cog-bezel', className)}>
      <Corner className="left-1 top-1" />
      <Corner className="right-1 top-1 rotate-90" />
      <Corner className="bottom-1 right-1 rotate-180" />
      <Corner className="bottom-1 left-1 -rotate-90" />
      <span className="cog-rail left-[6px]" aria-hidden />
      <span className="cog-rail right-[6px]" aria-hidden />
      <div className="cog-plate">
        <span className="cog-rivet" aria-hidden />
        <Lamps lamps={lamps} />
        <span className="cog-vents hidden sm:block" />
        <div className="cog-title">
          <span className="cog-plaque">{title}</span>
        </div>
        <span className="cog-vents hidden sm:block" />
        <Lamps lamps={[...lamps].reverse()} />
        <span className="cog-rivet" aria-hidden />
      </div>
      <div className={cx('cog-screen', screenClassName)}>
        {watermark && (
          <div className="cog-watermark" aria-hidden>
            <LogoMark className="size-56" />
          </div>
        )}
        <div className="relative z-[1]">{children}</div>
        {psalm && (
          <div
            className="cog-psalm relative z-[1] border-t border-l-accent/10 px-4 py-1.5"
            aria-hidden
          >
            {psalm}
          </div>
        )}
      </div>
    </div>
  );
}
