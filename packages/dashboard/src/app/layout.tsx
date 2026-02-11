import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://cogitator.app';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'Cogitator - Kubernetes for AI Agents',
    template: '%s | Cogitator',
  },
  description:
    'Self-hosted, production-grade AI agent orchestration platform. Multi-model support (Ollama, OpenAI, Anthropic, Google), workflows, swarms, memory/RAG, sandboxed code execution, and MCP protocol.',
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
    siteName: 'Cogitator',
    title: 'Cogitator - Kubernetes for AI Agents',
    description:
      'Self-hosted, production-grade AI agent orchestration. Multi-model, workflows, swarms, memory/RAG, sandboxed execution.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Cogitator - Kubernetes for AI Agents',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cogitator - Kubernetes for AI Agents',
    description:
      'Self-hosted, production-grade AI agent orchestration. Multi-model, workflows, swarms, memory/RAG.',
    images: ['/og-image.png'],
    creator: '@cogitator_dev',
  },
  alternates: {
    canonical: siteUrl,
  },
  category: 'technology',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
    { media: '(prefers-color-scheme: light)', color: '#0a0a0a' },
  ],
  colorScheme: 'dark',
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
      potentialAction: {
        '@type': 'SearchAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${siteUrl}/docs?q={search_term_string}`,
        },
        'query-input': 'required name=search_term_string',
      },
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
      sameAs: ['https://github.com/eL1Fe/cogitator', 'https://discord.gg/SkmRsYvA'],
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
      downloadUrl: 'https://github.com/eL1Fe/cogitator',
      softwareVersion: '0.0.1',
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js',
      featureList: [
        'Multi-model support (Ollama, OpenAI, Anthropic, Google)',
        'DAG-based workflow orchestration',
        'Multi-agent swarm coordination',
        'Vector memory and RAG',
        'Sandboxed code execution (Docker/WASM)',
        'Model Context Protocol (MCP)',
        'OpenTelemetry observability',
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
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-bg-primary text-text-primary`}
      >
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
