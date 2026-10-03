import { ImageResponse } from 'next/og';
import {
  LOGO_BRAIN_PATH,
  LOGO_COLORS,
  LOGO_GEAR_PATH,
  LOGO_SULCI_PATH,
  LOGO_VIEWBOX,
} from '@/lib/logo';

export const size = { width: 180, height: 180 };

export const contentType = 'image/png';

/** Home-screen icon: the mark on an ink tile with a faint phosphor glow. */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: LOGO_COLORS.ink,
        backgroundImage:
          'radial-gradient(circle at 50% 45%, rgba(0,255,136,0.18), transparent 65%)',
      }}
    >
      <svg viewBox={LOGO_VIEWBOX} width={132} height={132}>
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
    </div>,
    size
  );
}
