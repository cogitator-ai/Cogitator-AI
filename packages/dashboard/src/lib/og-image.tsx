import { ImageResponse } from 'next/og';
import type { ReactNode } from 'react';
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

const INK = '#07080a';
const BRASS = '#c9a45c';
const BRASS_DIM = '#8a6f3a';
const BRASS_LIGHT = '#e2c58c';
const PHOSPHOR_TEXT = '#dcefe6';
const PHOSPHOR_MUTED = '#8fb5a7';
const PHOSPHOR_FAINT = '#5f8a7c';
const PHOSPHOR_ACCENT = '#7fd4b5';

const DISPLAY_FONT = 'Cinzel';
const SCREEN_FONT = 'Share Tech Mono';
const BODY_FONT = 'Geist';

/**
 * Google Fonts CSS2 request for the card's typefaces. Without a browser user agent the API
 * answers with TrueType sources, which Satori can parse (it cannot read WOFF2).
 */
const FONTS_CSS_URL =
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=Geist:wght@400;500&family=Share+Tech+Mono&display=swap';

type FontWeight = 400 | 500 | 700;

interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: FontWeight;
  style: 'normal';
}

const FONT_FACE_PATTERN =
  /font-family:\s*'([^']+)';[\s\S]*?font-weight:\s*(\d+);[\s\S]*?src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/g;

function isFontWeight(weight: number): weight is FontWeight {
  return weight === 400 || weight === 500 || weight === 700;
}

async function fetchFonts(): Promise<OgFont[]> {
  const cssResponse = await fetch(FONTS_CSS_URL, { cache: 'force-cache' });
  if (!cssResponse.ok) {
    throw new Error(`OG image fonts: Google Fonts CSS returned ${cssResponse.status}`);
  }
  const css = await cssResponse.text();

  const faces = [...css.matchAll(FONT_FACE_PATTERN)].map(([, name, weight, url]) => ({
    name,
    weight: Number(weight),
    url,
  }));
  if (faces.length < 4) {
    throw new Error(
      `OG image fonts: expected 4 TrueType faces, Google Fonts listed ${faces.length}`
    );
  }

  return Promise.all(
    faces.map(async ({ name, weight, url }) => {
      if (!isFontWeight(weight)) {
        throw new Error(`OG image fonts: unexpected weight ${weight} for ${name}`);
      }
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`OG image fonts: ${name} ${weight} returned ${response.status}`);
      }
      return { name, weight, style: 'normal' as const, data: await response.arrayBuffer() };
    })
  );
}

let fontsPromise: Promise<OgFont[]> | undefined;

/**
 * Cinzel, Geist and Share Tech Mono as TrueType, fetched once per process. Requests go through
 * Next's data cache, so a build downloads each file once and every prerendered card reuses it.
 * A failed download is not memoised: the next render tries again instead of reusing the error.
 */
function loadFonts(): Promise<OgFont[]> {
  fontsPromise ??= fetchFonts().catch((error: unknown) => {
    fontsPromise = undefined;
    throw error;
  });
  return fontsPromise;
}

function Mark({ size, opacity = 1 }: { size: number; opacity?: number }) {
  return (
    <svg viewBox={LOGO_VIEWBOX} width={size} height={size} style={{ opacity }}>
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

function Rivet({ size = 10 }: { size?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size,
        backgroundImage: `radial-gradient(circle at 35% 35%, ${BRASS_LIGHT}, ${BRASS_DIM} 55%, #3b2f18)`,
        boxShadow: '0 1px 1px rgba(0,0,0,0.8)',
      }}
    />
  );
}

type Lamp = 'green' | 'amber' | 'red' | 'off';

const LAMP_COLORS: Record<Lamp, string> = {
  green: '#6fcfa8',
  amber: '#e0a64a',
  red: '#d9654f',
  off: '#2a2b2e',
};

function Lamps({ lamps }: { lamps: Lamp[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {lamps.map((lamp, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            width: 11,
            height: 11,
            borderRadius: 11,
            backgroundColor: LAMP_COLORS[lamp],
            border: '1px solid rgba(0,0,0,0.7)',
            boxShadow: lamp === 'off' ? 'none' : `0 0 10px ${LAMP_COLORS[lamp]}`,
          }}
        />
      ))}
    </div>
  );
}

function Vents() {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        padding: '2px 3px',
        borderRadius: 3,
        backgroundColor: '#050506',
      }}
    >
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          style={{ display: 'flex', width: 3, height: 12, backgroundColor: '#2c2d30' }}
        />
      ))}
    </div>
  );
}

const CORNER_PATH = 'M2 26V8a6 6 0 0 1 6-6h18';

function Corner({ rotate, position }: { rotate: number; position: Record<string, number> }) {
  return (
    <svg
      viewBox="0 0 28 28"
      width={40}
      height={40}
      style={{ position: 'absolute', ...position, transform: `rotate(${rotate}deg)` }}
    >
      <path d={CORNER_PATH} fill="none" stroke={BRASS} strokeOpacity={0.6} strokeWidth={3} />
      <path d={CORNER_PATH} fill="none" stroke="#0b0b0c" strokeOpacity={0.6} strokeWidth={0.8} />
      <circle
        cx={8}
        cy={8}
        r={1.8}
        fill={BRASS_DIM}
        stroke={BRASS_LIGHT}
        strokeOpacity={0.5}
        strokeWidth={0.5}
      />
    </svg>
  );
}

/** Title size that keeps long docs titles to two lines of Cinzel inside the screen. */
function titleFontSize(title: string): number {
  if (title.length <= 16) return 86;
  if (title.length <= 24) return 74;
  if (title.length <= 34) return 64;
  if (title.length <= 48) return 54;
  return 46;
}

/** Cut text at a word boundary so it fits the card, marking the cut with an ellipsis. */
function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  const cut = normalized.slice(0, max);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** What a card says. Every string is plain text; layout and styling live in {@link renderOgCard}. */
export interface OgCard {
  /** Text on the brass plaque above the screen, e.g. `docs`. */
  plaque: string;
  /** Status line at the top of the screen, framed as `+++ … +++`. */
  status: string;
  title: string;
  description?: string;
  /** Prompt line at the bottom of the screen, e.g. a docs breadcrumb. */
  prompt: string;
  /** Short facts shown as brass tags under the description. */
  tags?: string[];
  /** Lamp colour on the title plate; amber or red for warnings and errors. */
  lamp?: Exclude<Lamp, 'off'>;
}

/**
 * A 1200×630 social card in the Cogitator style: an iron bezel with brass corners and rivets,
 * a title plate with lamps and vents, and a phosphor screen carrying the page's title.
 */
export async function renderOgCard({
  plaque,
  status,
  title,
  description,
  prompt,
  tags = [],
  lamp = 'green',
}: OgCard): Promise<ImageResponse> {
  const fonts = await loadFonts();
  const host = new URL(SITE_URL).host;
  const lamps: Lamp[] = [lamp, 'amber', 'off'];

  const screen: ReactNode = (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        padding: '40px 52px 34px',
        borderRadius: 14,
        border: '1px solid rgba(127,212,181,0.14)',
        backgroundColor: '#061010',
        backgroundImage:
          'radial-gradient(ellipse at 50% 30%, #0e211e 0%, #081413 55%, #040a0a 100%)',
        boxShadow: 'inset 0 0 60px rgba(0,0,0,0.85)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          right: -60,
          bottom: -70,
          display: 'flex',
        }}
      >
        <Mark size={420} opacity={0.035} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <Mark size={52} />
        <div
          style={{
            display: 'flex',
            fontFamily: SCREEN_FONT,
            fontSize: 22,
            letterSpacing: 3.5,
            textTransform: 'uppercase',
            color: BRASS,
          }}
        >
          {`+++ ${status} +++`}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          justifyContent: 'center',
          paddingTop: 8,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontFamily: DISPLAY_FONT,
            fontWeight: 700,
            fontSize: titleFontSize(title),
            lineHeight: 1.08,
            letterSpacing: 0.5,
            color: PHOSPHOR_TEXT,
            textShadow: '0 0 28px rgba(127,212,181,0.28)',
            maxWidth: 960,
          }}
        >
          {clip(title, 72)}
        </div>
        {description && (
          <div
            style={{
              display: 'flex',
              marginTop: 22,
              fontFamily: BODY_FONT,
              fontWeight: 400,
              fontSize: 27,
              lineHeight: 1.4,
              color: PHOSPHOR_MUTED,
              maxWidth: 920,
            }}
          >
            {clip(description, 140)}
          </div>
        )}
        {tags.length > 0 && (
          <div style={{ display: 'flex', gap: 12, marginTop: 28 }}>
            {tags.map((tag) => (
              <div
                key={tag}
                style={{
                  display: 'flex',
                  flexShrink: 0,
                  padding: '7px 14px',
                  borderRadius: 4,
                  border: '1px solid rgba(201,164,92,0.45)',
                  backgroundImage: 'linear-gradient(180deg, #1d1912, #0c0b09)',
                  fontFamily: SCREEN_FONT,
                  fontSize: 19,
                  letterSpacing: 1.5,
                  textTransform: 'uppercase',
                  color: BRASS,
                }}
              >
                {tag}
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          paddingTop: 18,
          borderTop: '1px solid rgba(127,212,181,0.12)',
          fontFamily: SCREEN_FONT,
          fontSize: 22,
          letterSpacing: 1,
        }}
      >
        <div style={{ display: 'flex', color: PHOSPHOR_ACCENT, marginRight: 12 }}>{'>'}</div>
        <div style={{ display: 'flex', color: PHOSPHOR_FAINT }}>{clip(prompt, 60)}</div>
        <div
          style={{
            display: 'flex',
            width: 12,
            height: 22,
            marginLeft: 8,
            backgroundColor: PHOSPHOR_ACCENT,
            opacity: 0.7,
          }}
        />
        <div style={{ display: 'flex', marginLeft: 'auto', color: PHOSPHOR_FAINT }}>{host}</div>
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 4px)',
        }}
      />
    </div>
  );

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        padding: 26,
        backgroundColor: INK,
        backgroundImage:
          'radial-gradient(ellipse at 50% 110%, rgba(255,179,71,0.14), transparent 60%)',
      }}
    >
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          padding: '12px 24px 24px',
          borderRadius: 22,
          border: '1px solid #000',
          backgroundImage: 'linear-gradient(180deg, #2a2b2e 0%, #151618 45%, #1b1c1f 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.09), 0 0 70px rgba(255,179,71,0.10)',
        }}
      >
        <Corner rotate={0} position={{ left: 4, top: 4 }} />
        <Corner rotate={90} position={{ right: 4, top: 4 }} />
        <Corner rotate={180} position={{ right: 4, bottom: 4 }} />
        <Corner rotate={270} position={{ left: 4, bottom: 4 }} />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            height: 48,
            padding: '0 18px 10px',
          }}
        >
          <Rivet />
          <Lamps lamps={lamps} />
          <Vents />
          <div style={{ display: 'flex', flexGrow: 1, justifyContent: 'center' }}>
            <div
              style={{
                display: 'flex',
                padding: '5px 22px',
                borderRadius: 5,
                border: '1px solid rgba(201,164,92,0.45)',
                backgroundImage: 'linear-gradient(180deg, #1d1912, #0c0b09)',
                boxShadow: 'inset 0 1px 0 rgba(226,197,140,0.15)',
                fontFamily: SCREEN_FONT,
                fontSize: 19,
                letterSpacing: 4,
                textTransform: 'uppercase',
                color: BRASS,
              }}
            >
              {`${SITE_NAME} · ${plaque}`}
            </div>
          </div>
          <Vents />
          <Lamps lamps={[...lamps].reverse()} />
          <Rivet />
        </div>

        {screen}
      </div>
    </div>,
    {
      ...OG_IMAGE_SIZE,
      fonts: fonts.map(({ name, data, weight, style }) => ({ name, data, weight, style })),
    }
  );
}

/** Social card of the landing page, shared by the root `opengraph-image` and `twitter-image`. */
export function renderLandingOgImage(): Promise<ImageResponse> {
  return renderOgCard({
    plaque: `core v${corePackage.version}`,
    status: 'Self-hosted TypeScript runtime',
    title: SITE_TAGLINE,
    description:
      'Tools with human approval, durable workflows, swarms, memory and RAG on any model.',
    tags: [
      `${LLM_PROVIDERS.length} LLM providers`,
      `${MEMORY_BACKENDS.length} memory backends`,
      `${SWARM_STRATEGIES.length} swarm strategies`,
      'MCP + A2A',
    ],
    prompt: 'npx create-cogitator-app my-agents',
  });
}

export const NOT_FOUND_OG_IMAGE_PATH = '/og/not-found.png';

export const NOT_FOUND_OG_IMAGE_ALT = `${SITE_NAME} - page not found`;

/** Social card for the 404 page, worded like the page's own vox log. */
export function renderNotFoundOgImage(): Promise<ImageResponse> {
  return renderOgCard({
    plaque: 'vox log',
    status: 'Transmission lost',
    title: 'Page not found',
    description:
      'The machine spirit could not find this page. It may have moved, or the link was mistyped.',
    prompt: 'status 404 · no such page',
    lamp: 'red',
  });
}

/**
 * The mark on a square iron tile with a faint phosphor glow, for favicons and home-screen icons.
 * The tile is full-bleed so platforms can apply their own corner mask; on large sizes the mark
 * fills 70% of it, inside the maskable safe zone.
 */
export function renderIconTile(size: number): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: INK,
        backgroundImage:
          'radial-gradient(circle at 50% 45%, rgba(127,212,181,0.16), transparent 62%), linear-gradient(180deg, #1b1c1f 0%, #07080a 100%)',
      }}
    >
      <Mark size={Math.round(size * (size >= 96 ? 0.7 : 0.9))} />
    </div>,
    { width: size, height: size }
  );
}
