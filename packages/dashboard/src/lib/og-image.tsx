import { ImageResponse } from 'next/og';
import corePackage from '../../../core/package.json';
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from '@/lib/site';
import {
  LOGO_BRAIN_PATH,
  LOGO_COLORS,
  LOGO_GEAR_PATH,
  LOGO_SULCI_PATH,
  LOGO_VIEWBOX,
} from '@/lib/logo';
import { LLM_PROVIDERS, MEMORY_BACKENDS, SWARM_STRATEGIES } from '@/lib/stats';

export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export const OG_IMAGE_ALT = `${SITE_NAME} - ${SITE_TAGLINE}`;

export const OG_IMAGE_CONTENT_TYPE = 'image/png';

const chips = [
  `${LLM_PROVIDERS.length} LLM providers`,
  `${MEMORY_BACKENDS.length} memory backends`,
  `${SWARM_STRATEGIES.length} swarm strategies`,
  'MCP + A2A',
];

/** Social preview card shared by `opengraph-image` and `twitter-image`. */
export function renderOgImage(): ImageResponse {
  const host = new URL(SITE_URL).host;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        backgroundColor: '#07080a',
        backgroundImage:
          'radial-gradient(ellipse at 50% 0%, rgba(0,255,136,0.13), transparent 60%), radial-gradient(circle at 90% 100%, rgba(201,164,92,0.10), transparent 45%)',
        color: '#fafafa',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <svg viewBox={LOGO_VIEWBOX} width={72} height={72}>
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
        <div style={{ display: 'flex', fontSize: 36, letterSpacing: -0.5 }}>{SITE_NAME}</div>
        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            padding: '8px 18px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.13)',
            color: '#8b8f98',
            fontSize: 22,
          }}
        >
          {`@cogitator-ai/core v${corePackage.version}`}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontSize: 88, lineHeight: 1.02, letterSpacing: -3.5 }}>
          Agents that survive
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 88,
            lineHeight: 1.02,
            letterSpacing: -3.5,
            color: '#8b8f98',
          }}
        >
          production.
        </div>
        <div style={{ display: 'flex', marginTop: 28, fontSize: 30, color: '#8b8f98' }}>
          Self-hosted TypeScript runtime · approvals · durable workflows · swarms
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {chips.map((chip) => (
          <div
            key={chip}
            style={{
              display: 'flex',
              flexShrink: 0,
              whiteSpace: 'nowrap',
              padding: '8px 16px',
              borderRadius: 999,
              border: '1px solid rgba(201,164,92,0.35)',
              backgroundColor: 'rgba(201,164,92,0.06)',
              color: '#c9a45c',
              fontSize: 20,
            }}
          >
            {chip}
          </div>
        ))}
        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            whiteSpace: 'nowrap',
            fontSize: 22,
            color: '#5d616b',
          }}
        >
          {host}
        </div>
      </div>
    </div>,
    OG_IMAGE_SIZE
  );
}
