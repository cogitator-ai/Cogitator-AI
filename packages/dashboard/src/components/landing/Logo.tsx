import {
  LOGO_BRAIN_PATH,
  LOGO_COLORS,
  LOGO_GEAR_PATH,
  LOGO_SULCI_PATH,
  LOGO_VIEWBOX,
} from '@/lib/logo';
import { cx } from './cx';

/** The Cogitator mark: a phosphor-green brain beside a brass half-gear. */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      className={cx('size-7', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={LOGO_BRAIN_PATH} fill={LOGO_COLORS.phosphor} />
      <path
        d={LOGO_SULCI_PATH}
        fill="none"
        stroke={LOGO_COLORS.ink}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
      <path d={LOGO_GEAR_PATH} fill={LOGO_COLORS.brass} fillRule="evenodd" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="imperial text-[16px] font-semibold tracking-[0.06em] text-l-text">
        Cogitator
      </span>
    </span>
  );
}
