import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { defaultModels, providerConfig } from '../utils/providers.js';

export const nextjsTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = defaultModels[options.provider];

    const agentTs = [
      `import { Cogitator, Agent, tool } from '@cogitator-ai/core'`,
      `import { z } from 'zod'`,
      ``,
      `const searchTool = tool({`,
      `  name: 'search',`,
      `  description: 'Search for information',`,
      `  parameters: z.object({`,
      `    query: z.string().describe('Search query'),`,
      `  }),`,
      `  execute: async ({ query }) => {`,
      `    return \`Results for: \${query}\``,
      `  },`,
      `})`,
      ``,
      `export const cogitator = new Cogitator({`,
      providerConfig(options.provider),
      `})`,
      ``,
      `export const agent = new Agent({`,
      `  name: '${options.name}-chat',`,
      `  model: '${model}',`,
      `  instructions: 'You are a helpful AI chat assistant. Be conversational and helpful.',`,
      `  tools: [searchTool],`,
      `  temperature: 0.7,`,
      `})`,
      ``,
    ].join('\n');

    const routeTs = [
      `import { createChatHandler } from '@cogitator-ai/next'`,
      `import { cogitator, agent } from '@/lib/agent'`,
      ``,
      `export const POST = createChatHandler(cogitator, agent)`,
      ``,
    ].join('\n');

    const pageTsx = [
      `'use client'`,
      ``,
      `import { useCogitatorChat } from '@cogitator-ai/next/client'`,
      `import { useState, useRef, useEffect } from 'react'`,
      ``,
      `export default function Home() {`,
      `  const { messages, input, setInput, send, isLoading } = useCogitatorChat({`,
      `    api: '/api/chat',`,
      `  })`,
      `  const messagesEndRef = useRef<HTMLDivElement>(null)`,
      ``,
      `  useEffect(() => {`,
      `    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })`,
      `  }, [messages])`,
      ``,
      `  const handleSubmit = (e: React.FormEvent) => {`,
      `    e.preventDefault()`,
      `    if (!input.trim() || isLoading) return`,
      `    send(input)`,
      `    setInput('')`,
      `  }`,
      ``,
      `  return (`,
      `    <main className="flex min-h-screen flex-col items-center p-4 bg-gray-950 text-white">`,
      `      <div className="w-full max-w-2xl flex flex-col h-screen">`,
      `        <header className="py-6 text-center">`,
      `          <h1 className="text-2xl font-bold">${options.name}</h1>`,
      `          <p className="text-gray-400 text-sm mt-1">Powered by Cogitator</p>`,
      `        </header>`,
      ``,
      `        <div className="flex-1 overflow-y-auto space-y-4 pb-4">`,
      `          {messages.map((msg, i) => (`,
      `            <div`,
      `              key={i}`,
      `              className={\`flex \${msg.role === 'user' ? 'justify-end' : 'justify-start'}\`}`,
      `            >`,
      `              <div`,
      `                className={\`max-w-[80%] rounded-2xl px-4 py-2 \${`,
      `                  msg.role === 'user'`,
      `                    ? 'bg-blue-600 text-white'`,
      `                    : 'bg-gray-800 text-gray-100'`,
      `                }\`}`,
      `              >`,
      `                {msg.content}`,
      `              </div>`,
      `            </div>`,
      `          ))}`,
      `          {isLoading && (`,
      `            <div className="flex justify-start">`,
      `              <div className="bg-gray-800 rounded-2xl px-4 py-2 text-gray-400">`,
      `                Thinking...`,
      `              </div>`,
      `            </div>`,
      `          )}`,
      `          <div ref={messagesEndRef} />`,
      `        </div>`,
      ``,
      `        <form onSubmit={handleSubmit} className="flex gap-2 py-4">`,
      `          <input`,
      `            value={input}`,
      `            onChange={(e) => setInput(e.target.value)}`,
      `            placeholder="Type a message..."`,
      `            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"`,
      `          />`,
      `          <button`,
      `            type="submit"`,
      `            disabled={isLoading || !input.trim()}`,
      `            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl px-6 py-3 font-medium transition-colors"`,
      `          >`,
      `            Send`,
      `          </button>`,
      `        </form>`,
      `      </div>`,
      `    </main>`,
      `  )`,
      `}`,
      ``,
    ].join('\n');

    const layoutTsx = [
      `import type { Metadata } from 'next'`,
      `import './globals.css'`,
      ``,
      `export const metadata: Metadata = {`,
      `  title: '${options.name}',`,
      `  description: 'AI chat app powered by Cogitator',`,
      `}`,
      ``,
      `export default function RootLayout({`,
      `  children,`,
      `}: {`,
      `  children: React.ReactNode`,
      `}) {`,
      `  return (`,
      `    <html lang="en">`,
      `      <body>{children}</body>`,
      `    </html>`,
      `  )`,
      `}`,
      ``,
    ].join('\n');

    const globalsCss = [
      `@tailwind base;`,
      `@tailwind components;`,
      `@tailwind utilities;`,
      ``,
    ].join('\n');

    const nextConfig = [
      `import type { NextConfig } from 'next'`,
      ``,
      `const config: NextConfig = {}`,
      ``,
      `export default config`,
      ``,
    ].join('\n');

    const tsconfigJson = JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./src/*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2
    );

    const tailwindConfig = [
      `import type { Config } from 'tailwindcss'`,
      ``,
      `const config: Config = {`,
      `  content: ['./src/**/*.{ts,tsx}'],`,
      `  theme: { extend: {} },`,
      `  plugins: [],`,
      `}`,
      ``,
      `export default config`,
      ``,
    ].join('\n');

    const postcssConfig = [
      `const config = {`,
      `  plugins: {`,
      `    tailwindcss: {},`,
      `    autoprefixer: {},`,
      `  },`,
      `}`,
      ``,
      `export default config`,
      ``,
    ].join('\n');

    return [
      { path: 'src/lib/agent.ts', content: agentTs },
      { path: 'src/app/api/chat/route.ts', content: routeTs },
      { path: 'src/app/page.tsx', content: pageTsx },
      { path: 'src/app/layout.tsx', content: layoutTsx },
      { path: 'src/app/globals.css', content: globalsCss },
      { path: 'next.config.ts', content: nextConfig },
      { path: 'tsconfig.json', content: tsconfigJson },
      { path: 'tailwind.config.ts', content: tailwindConfig },
      { path: 'postcss.config.mjs', content: postcssConfig },
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': 'latest',
      '@cogitator-ai/next': 'latest',
      next: '^15.0.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      zod: '^3.23.0',
    };
  },

  devDependencies() {
    return {
      typescript: '^5.8.0',
      '@types/node': '^22.0.0',
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      tailwindcss: '^3.4.0',
      autoprefixer: '^10.4.0',
      postcss: '^8.4.0',
    };
  },

  scripts() {
    return {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    };
  },
};
