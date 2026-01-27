'use client';

import { motion } from 'framer-motion';
import { FeatureCard } from './FeatureCard';
import { Layers, GitBranch, Users, Brain, Shield, Plug, Activity, Server } from 'lucide-react';

const features = [
  {
    title: 'Multi-Model Runtime',
    description:
      'Run Ollama, vLLM, OpenAI, Anthropic, or Google models with identical code. Switch providers without changing a line.',
    icon: <Layers className="w-6 h-6" />,
    glowColor: '#00ff88',
    className: 'md:col-span-2',
  },
  {
    title: 'DAG Workflows',
    description:
      'Build complex agent pipelines with retry, compensation, and human-in-the-loop steps.',
    icon: <GitBranch className="w-6 h-6" />,
    glowColor: '#00aaff',
  },
  {
    title: 'Multi-Agent Swarms',
    description:
      '6 coordination strategies out of the box. Hierarchical, consensus, round-robin, and more.',
    icon: <Users className="w-6 h-6" />,
    glowColor: '#00aaff',
  },
  {
    title: 'Production Memory',
    description:
      'Redis for speed, Postgres for persistence, pgvector for semantic search. Your agents remember everything.',
    icon: <Brain className="w-6 h-6" />,
    glowColor: '#00ff88',
    className: 'md:col-span-2',
  },
  {
    title: 'Sandboxed Execution',
    description: 'Run untrusted code in Docker containers or WASM. Never on your host.',
    icon: <Shield className="w-6 h-6" />,
    glowColor: '#ffaa00',
  },
  {
    title: 'MCP Protocol',
    description:
      'First-class support for Model Context Protocol. Connect any MCP server as a tool.',
    icon: <Plug className="w-6 h-6" />,
    glowColor: '#00aaff',
  },
  {
    title: 'Server Adapters',
    description:
      'Express, Fastify, Hono, Koa — mount agents as REST APIs with SSE streaming, WebSocket, and auto-generated Swagger docs.',
    icon: <Server className="w-6 h-6" />,
    glowColor: '#00aaff',
    className: 'md:col-span-2',
  },
  {
    title: 'Full Observability',
    description:
      'OpenTelemetry traces, Prometheus metrics, cost tracking. Know exactly what your agents are doing.',
    icon: <Activity className="w-6 h-6" />,
    glowColor: '#00ff88',
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
            <FeatureCard key={feature.title} {...feature} delay={i * 0.1} />
          ))}
        </div>
      </div>
    </section>
  );
}
