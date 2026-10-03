import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { RootProvider } from 'fumadocs-ui/provider/next';
import corePackage from '../../../core/package.json';
import { CHANNELS, LLM_PROVIDERS, MEMORY_BACKENDS, SWARM_STRATEGIES } from '@/lib/stats';
import {
  COMMUNITY,
  GITHUB_URL,
  LLMS_TXT_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from '@/lib/site';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const siteUrl = SITE_URL;
const siteTitle = `${SITE_NAME} - ${SITE_TAGLINE}`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: [
    'AI agents',
    'LLM orchestration',
    'agent framework',
    'multi-agent systems',
    'AI swarms',
    'Ollama',
    'OpenAI',
    'Anthropic',
    'Claude',
    'GPT',
    'self-hosted AI',
    'TypeScript AI',
    'RAG',
    'vector memory',
    'MCP protocol',
    'AI workflows',
    'autonomous agents',
    'code sandbox',
    'Docker AI',
    'WASM sandbox',
  ],
  authors: [{ name: 'Cogitator Team' }],
  creator: 'Cogitator',
  publisher: 'Cogitator',
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
    icon: '/favicon.svg',
    apple: '/favicon.svg',
  },
  manifest: '/manifest.json',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: siteUrl,
    siteName: SITE_NAME,
    title: siteTitle,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: SITE_DESCRIPTION,
    creator: '@cogitator_dev',
  },
  alternates: {
    canonical: './',
    types: {
      'text/markdown': LLMS_TXT_URL,
    },
  },
  category: 'technology',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
  colorScheme: 'dark light',
  width: 'device-width',
  initialScale: 1,
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${siteUrl}/#website`,
      url: siteUrl,
      name: 'Cogitator',
      description: 'Self-hosted, production-grade AI agent orchestration platform',
      publisher: { '@id': `${siteUrl}/#organization` },
    },
    {
      '@type': 'Organization',
      '@id': `${siteUrl}/#organization`,
      name: 'Cogitator',
      url: siteUrl,
      logo: {
        '@type': 'ImageObject',
        url: `${siteUrl}/favicon.svg`,
      },
      sameAs: [GITHUB_URL, COMMUNITY.url],
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${siteUrl}/#software`,
      name: 'Cogitator',
      description:
        'The Sovereign AI Agent Runtime - Self-hosted, production-grade orchestration for LLM swarms and autonomous agents',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      author: { '@id': `${siteUrl}/#organization` },
      downloadUrl: GITHUB_URL,
      softwareVersion: corePackage.version,
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js',
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
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <RootProvider theme={{ defaultTheme: 'dark' }}>{children}</RootProvider>
      </body>
    </html>
  );
}
