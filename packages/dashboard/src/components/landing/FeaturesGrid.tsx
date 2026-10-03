'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { FeatureCard } from './FeatureCard';
import {
  Activity,
  ArrowRightLeft,
  Brain,
  Cloud,
  GitBranch,
  Hand,
  Layers,
  MessageSquare,
  Plug,
  Server,
  Shield,
  ShieldCheck,
  Terminal,
  Users,
} from 'lucide-react';
import {
  CHANNELS,
  LLM_PROVIDERS,
  MEMORY_BACKENDS,
  SWARM_STRATEGIES,
  BUILTIN_TOOL_COUNT,
} from '@/lib/stats';

const features = [
  {
    title: 'Multi-Model Runtime',
    description: `${LLM_PROVIDERS.length} providers behind one model string: ${LLM_PROVIDERS.join(', ')}. Rate limits and outages are retried for you, honouring Retry-After.`,
    icon: <Layers className="w-6 h-6" />,
    glowColor: '#00ff88',
    className: 'md:col-span-2',
    href: '/docs/core/llm-backends',
  },
  {
    title: 'Tools with Approvals',
    description: `${BUILTIN_TOOL_COUNT} built-in tools plus type-safe custom ones. Risky calls pause the run until a person approves, then it resumes where it stopped.`,
    icon: <Hand className="w-6 h-6" />,
    glowColor: '#ffaa00',
    href: '/docs/tools/approvals',
  },
  {
    title: 'Handoffs & Reasoning',
    description:
      'Agents hand the conversation to a specialist, and reasoning models think before answering with one effort setting for every provider.',
    icon: <ArrowRightLeft className="w-6 h-6" />,
    glowColor: '#00aaff',
    href: '/docs/core/agents#handoffs',
  },
  {
    title: 'Production Memory',
    description: `${MEMORY_BACKENDS.join(', ')}. Hybrid BM25 + vector search and knowledge graphs; one agent serves many users, each with private threads and memory.`,
    icon: <Brain className="w-6 h-6" />,
    glowColor: '#00ff88',
    className: 'md:col-span-2',
    href: '/docs/memory/adapters',
  },
  {
    title: 'Durable Workflows',
    description:
      'DAG pipelines with retries, sagas, human approval and timers. Runs, approvals and timers survive restarts in Redis or Postgres.',
    icon: <GitBranch className="w-6 h-6" />,
    glowColor: '#00aaff',
    href: '/docs/workflows/execution',
  },
  {
    title: 'Multi-Agent Swarms',
    description: `${SWARM_STRATEGIES.length} strategies out of the box: ${SWARM_STRATEGIES.join(', ')}.`,
    icon: <Users className="w-6 h-6" />,
    glowColor: '#00aaff',
    href: '/docs/swarms/strategies',
  },
  {
    title: 'Safety & PII Masking',
    description:
      'Prompt-injection detection, constitutional guardrails, and PII masking so emails, cards and keys never reach the model provider.',
    icon: <ShieldCheck className="w-6 h-6" />,
    glowColor: '#ffaa00',
    href: '/docs/advanced/security',
  },
  {
    title: 'Messaging Channels',
    description: `One assistant on ${CHANNELS.join(', ')} — configured from a YAML file, with streaming replies, owner commands, voice notes and a scheduler.`,
    icon: <MessageSquare className="w-6 h-6" />,
    glowColor: '#00ff88',
    className: 'md:col-span-2',
    href: '/docs/channels/gateway',
  },
  {
    title: 'MCP Protocol',
    description:
      'Use any MCP server as tools, serve your agents to Claude Desktop or Cursor in one line, act with each user’s own credentials.',
    icon: <Plug className="w-6 h-6" />,
    glowColor: '#00aaff',
    href: '/docs/integrations/mcp',
  },
  {
    title: 'Sandboxed Execution',
    description: 'Run untrusted code in Docker containers or WASM. Never on your host.',
    icon: <Shield className="w-6 h-6" />,
    glowColor: '#ffaa00',
    href: '/docs/deployment/sandbox',
  },
  {
    title: 'Full Observability',
    description:
      'OpenTelemetry traces, Langfuse, Prometheus metrics and cost tracking. Know exactly what your agents are doing.',
    icon: <Activity className="w-6 h-6" />,
    glowColor: '#00ff88',
    href: '/docs/deployment/observability',
  },
  {
    title: 'Edge Runtimes',
    description:
      'Run agents on Cloudflare Workers and Deno with database-backed memory, or on Bun with the Tetsu adapter.',
    icon: <Cloud className="w-6 h-6" />,
    glowColor: '#00aaff',
    href: '/docs/deployment/edge',
  },
  {
    title: 'Server Adapters',
    description:
      'Express, Fastify, Hono, Koa, Tetsu — mount agents as REST APIs with SSE streaming, WebSocket, and auto-generated OpenAPI docs.',
    icon: <Server className="w-6 h-6" />,
    glowColor: '#00aaff',
    className: 'md:col-span-2',
    href: '/docs/server-adapters',
  },
  {
    title: 'CLI & Deploy',
    description:
      'cogitator init, up and daemon for local assistants; cogitator deploy ships to Docker or Fly.io.',
    icon: <Terminal className="w-6 h-6" />,
    glowColor: '#00ff88',
    href: '/docs/cli',
  },
];

const ecosystem = [
  {
    name: 'RAG',
    pkg: '@cogitator-ai/rag',
    description: 'Loaders, chunking, retrieval, reranking',
    href: '/docs/rag',
  },
  {
    name: 'Evals',
    pkg: '@cogitator-ai/evals',
    description: 'Metrics, LLM judges, A/B comparison',
    href: '/docs/evals',
  },
  {
    name: 'Voice',
    pkg: '@cogitator-ai/voice',
    description: 'STT, TTS, VAD and realtime sessions',
    href: '/docs/voice',
  },
  {
    name: 'Browser',
    pkg: '@cogitator-ai/browser',
    description: 'Playwright tools, stealth, vision',
    href: '/docs/browser',
  },
  {
    name: 'A2A Protocol',
    pkg: '@cogitator-ai/a2a',
    description: 'Expose and call agents across frameworks',
    href: '/docs/integrations/a2a',
  },
  {
    name: 'Next.js',
    pkg: '@cogitator-ai/next',
    description: 'App Router handlers and streaming',
    href: '/docs/integrations/nextjs',
  },
  {
    name: 'Vercel AI SDK',
    pkg: '@cogitator-ai/ai-sdk',
    description: 'Use AI SDK models and tools both ways',
    href: '/docs/integrations/ai-sdk',
  },
  {
    name: 'OpenAI-compatible API',
    pkg: '@cogitator-ai/openai-compat',
    description: 'Serve agents through the Assistants API',
    href: '/docs/integrations/openai-compat',
  },
  {
    name: 'Prompt Versions',
    pkg: '@cogitator-ai/core',
    description: 'Deploy, roll back and A/B test instructions',
    href: '/docs/advanced/prompt-versions',
  },
  {
    name: 'Self-Modifying Agents',
    pkg: '@cogitator-ai/self-modifying',
    description: 'Generate new tools at runtime',
    href: '/docs/advanced/self-modifying',
  },
  {
    name: 'Neuro-Symbolic',
    pkg: '@cogitator-ai/neuro-symbolic',
    description: 'Prolog-style logic, SAT/SMT solving',
    href: '/docs/advanced/neuro-symbolic',
  },
  {
    name: 'WASM Tools',
    pkg: '@cogitator-ai/wasm-tools',
    description: '14 pre-built tools in a WASM sandbox',
    href: '/docs/tools/wasm-tools',
  },
];

export function FeaturesGrid() {
  return (
    <section className="relative py-32 px-6">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold text-[#fafafa] mb-4">
            Everything you need for{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00ff88] to-[#00aaff]">
              production AI
            </span>
          </h2>
          <p className="text-[#a1a1a1] text-lg max-w-2xl mx-auto">
            From local development to global scale. No vendor lock-in.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {features.map((feature, i) => (
            <FeatureCard key={feature.title} {...feature} delay={(i % 3) * 0.1} />
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mt-28 mb-10"
        >
          <h3 className="text-2xl md:text-3xl font-bold text-[#fafafa] mb-3">
            Install only what you need
          </h3>
          <p className="text-[#a1a1a1] max-w-2xl mx-auto">
            Every capability ships as its own package with docs and runnable examples.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {ecosystem.map((item, i) => (
            <motion.div
              key={item.name}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.4, delay: (i % 4) * 0.05 }}
            >
              <Link
                href={item.href}
                className="group block h-full rounded-xl border border-[#262626] bg-[#111111] p-4 hover:border-[#00ff88]/40 hover:bg-[#00ff88]/[0.03] transition-colors focus-visible:outline-none focus-visible:border-[#00ff88]/60"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-semibold text-[#fafafa] group-hover:text-[#00ff88] transition-colors">
                    {item.name}
                  </span>
                </div>
                <p className="text-sm text-[#a1a1a1] mb-3">{item.description}</p>
                <code className="text-xs font-mono text-[#666666]">{item.pkg}</code>
              </Link>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
