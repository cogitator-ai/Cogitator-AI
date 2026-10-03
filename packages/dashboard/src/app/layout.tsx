import type { Metadata, Viewport } from 'next';
import { Cinzel, Geist, Geist_Mono, Share_Tech_Mono } from 'next/font/google';
import { RootProvider } from 'fumadocs-ui/provider/next';
import corePackage from '../../../core/package.json';
import { CHANNELS, LLM_PROVIDERS, MEMORY_BACKENDS, SWARM_STRATEGIES } from '@/lib/stats';
import {
  DOCS_HOME,
  GITHUB_ORG_URL,
  GITHUB_URL,
  LICENSE_URL,
  LLMS_TXT_URL,
  NPM_ORG_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from '@/lib/site';
import {
  absoluteUrl,
  jsonLd,
  LOGO_PNG,
  OPEN_GRAPH_BASE,
  ORGANIZATION_ID,
  SOFTWARE_ID,
  SOURCE_CODE_ID,
  WEBSITE_ID,
} from '@/lib/seo';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const imperial = Cinzel({
  variable: '--font-cinzel',
  weight: ['500', '600', '700'],
  subsets: ['latin'],
});

const screenMono = Share_Tech_Mono({
  variable: '--font-share-tech',
  weight: '400',
  subsets: ['latin'],
});

const siteTitle = `${SITE_NAME} - ${SITE_TAGLINE}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: siteTitle,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    'AI agents',
    'AI agent framework',
    'AI agent runtime',
    'TypeScript AI agents',
    'LLM orchestration',
    'multi-agent systems',
    'agent swarms',
    'self-hosted AI',
    'human-in-the-loop',
    'tool calling',
    'agent memory',
    'RAG',
    'DAG workflows',
    'Model Context Protocol',
    'MCP',
    'Agent2Agent protocol',
    'A2A',
    'sandboxed code execution',
    'Ollama',
    'OpenAI',
    'Anthropic',
    'Gemini',
  ],
  authors: [{ name: 'Cogitator contributors', url: `${GITHUB_URL}/graphs/contributors` }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: 'technology',
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icon/48', type: 'image/png', sizes: '48x48' },
    ],
    apple: [{ url: '/apple-icon', type: 'image/png', sizes: '180x180' }],
  },
  manifest: '/manifest.json',
  openGraph: {
    ...OPEN_GRAPH_BASE,
    type: 'website',
    url: '/',
    title: siteTitle,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: SITE_DESCRIPTION,
  },
  alternates: {
    canonical: './',
    types: {
      'text/markdown': LLMS_TXT_URL,
    },
  },
};

export const viewport: Viewport = {
  themeColor: '#07080a',
  colorScheme: 'dark light',
  width: 'device-width',
  initialScale: 1,
};

const logoId = `${SITE_URL}/#logo`;

/** Who publishes the site and what the software is; docs and cookbook pages reference these by `@id`. */
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: SITE_NAME,
      url: SITE_URL,
      logo: {
        '@type': 'ImageObject',
        '@id': logoId,
        url: absoluteUrl(LOGO_PNG.path),
        contentUrl: absoluteUrl(LOGO_PNG.path),
        width: LOGO_PNG.size,
        height: LOGO_PNG.size,
        caption: SITE_NAME,
      },
      image: { '@id': logoId },
      sameAs: [GITHUB_ORG_URL, NPM_ORG_URL],
    },
    {
      '@type': 'WebSite',
      '@id': WEBSITE_ID,
      url: SITE_URL,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      inLanguage: 'en',
      publisher: { '@id': ORGANIZATION_ID },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': SOFTWARE_ID,
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      image: absoluteUrl('/opengraph-image'),
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'AI agent runtime',
      operatingSystem: 'Linux, macOS, Windows',
      softwareVersion: corePackage.version,
      license: LICENSE_URL,
      isAccessibleForFree: true,
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      downloadUrl: `https://www.npmjs.com/package/${corePackage.name}`,
      softwareHelp: { '@type': 'CreativeWork', url: absoluteUrl(DOCS_HOME) },
      author: { '@id': ORGANIZATION_ID },
      publisher: { '@id': ORGANIZATION_ID },
      featureList: [
        `${LLM_PROVIDERS.length} built-in LLM providers (${LLM_PROVIDERS.join(', ')})`,
        'Tools with human approval, pause and resume',
        'Agent handoffs and model reasoning',
        `Memory backends: ${MEMORY_BACKENDS.join(', ')}`,
        'RAG pipeline and evaluation framework',
        'DAG workflows with durable run stores',
        `Multi-agent swarms with ${SWARM_STRATEGIES.length} strategies`,
        'Sandboxed code execution (Docker/WASM)',
        'Model Context Protocol (MCP) and Agent-to-Agent (A2A) protocol',
        `Messaging channels: ${CHANNELS.join(', ')}`,
        'OpenTelemetry and Langfuse observability',
        'TypeScript-native SDK',
      ],
    },
    {
      '@type': 'SoftwareSourceCode',
      '@id': SOURCE_CODE_ID,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      codeRepository: GITHUB_URL,
      programmingLanguage: {
        '@type': 'ComputerLanguage',
        name: 'TypeScript',
        url: 'https://www.typescriptlang.org',
      },
      runtimePlatform: 'Node.js',
      version: corePackage.version,
      license: LICENSE_URL,
      targetProduct: { '@id': SOFTWARE_ID },
      author: { '@id': ORGANIZATION_ID },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${screenMono.variable} ${imperial.variable} antialiased`}
      >
        <RootProvider theme={{ defaultTheme: 'dark' }}>{children}</RootProvider>
      </body>
    </html>
  );
}
