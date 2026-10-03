import { ImageResponse } from 'next/og';
import corePackage from '../../../core/package.json';
import { SITE_NAME, SITE_TAGLINE, SITE_URL } from '@/lib/site';
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
        backgroundColor: '#0a0a0a',
        backgroundImage:
          'radial-gradient(circle at 85% 15%, rgba(0,170,255,0.18), transparent 45%), radial-gradient(circle at 10% 90%, rgba(0,255,136,0.16), transparent 45%)',
        color: '#fafafa',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            width: 72,
            height: 72,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 18,
            border: '2px solid rgba(0,255,136,0.5)',
            backgroundColor: 'rgba(0,255,136,0.08)',
            color: '#00ff88',
            fontSize: 44,
          }}
        >
          C
        </div>
        <div style={{ display: 'flex', fontSize: 36, letterSpacing: -0.5 }}>{SITE_NAME}</div>
        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            padding: '8px 18px',
            borderRadius: 999,
            border: '1px solid #333333',
            color: '#a1a1a1',
            fontSize: 22,
          }}
        >
          {`@cogitator-ai/core v${corePackage.version}`}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontSize: 84, lineHeight: 1.05, letterSpacing: -2 }}>
          Kubernetes for
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 84,
            lineHeight: 1.05,
            letterSpacing: -2,
            backgroundImage: 'linear-gradient(90deg, #00ff88, #00ddaa, #00aaff)',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          AI Agents
        </div>
        <div style={{ display: 'flex', marginTop: 28, fontSize: 32, color: '#a1a1a1' }}>
          Self-hosted. Production-grade. TypeScript-native.
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
              border: '1px solid rgba(0,255,136,0.35)',
              backgroundColor: 'rgba(0,255,136,0.06)',
              color: '#00ff88',
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
            color: '#666666',
          }}
        >
          {host}
        </div>
      </div>
    </div>,
    OG_IMAGE_SIZE
  );
}
