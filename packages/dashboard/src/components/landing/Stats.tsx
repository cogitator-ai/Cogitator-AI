'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { GITHUB_EXAMPLES_URL } from '@/lib/site';
import {
  BUILTIN_TOOL_COUNT,
  EXAMPLE_COUNT,
  LLM_PROVIDERS,
  MEMORY_BACKENDS,
  NPM_PACKAGE_COUNT,
  SWARM_STRATEGIES,
} from '@/lib/stats';

const stats = [
  { value: LLM_PROVIDERS.length, label: 'LLM providers', href: '/docs/core/llm-backends' },
  { value: MEMORY_BACKENDS.length, label: 'memory backends', href: '/docs/memory/adapters' },
  { value: SWARM_STRATEGIES.length, label: 'swarm strategies', href: '/docs/swarms/strategies' },
  { value: BUILTIN_TOOL_COUNT, label: 'built-in tools', href: '/docs/tools/built-in' },
  {
    value: NPM_PACKAGE_COUNT,
    label: 'npm packages',
    href: 'https://www.npmjs.com/org/cogitator-ai',
  },
  { value: EXAMPLE_COUNT, label: 'runnable examples', href: GITHUB_EXAMPLES_URL },
];

export function Stats() {
  return (
    <section className="relative px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="max-w-6xl mx-auto grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px overflow-hidden rounded-2xl border border-[#262626] bg-[#262626]"
      >
        {stats.map((stat) => {
          const external = stat.href.startsWith('http');
          return (
            <Link
              key={stat.label}
              href={stat.href}
              target={external ? '_blank' : undefined}
              rel={external ? 'noopener noreferrer' : undefined}
              className="group flex flex-col items-center justify-center gap-1 bg-[#0d0d0d] px-4 py-6 hover:bg-[#111111] transition-colors"
            >
              <span className="text-3xl md:text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#00ff88] to-[#00aaff] tabular-nums">
                {stat.value}
              </span>
              <span className="text-sm text-[#a1a1a1] group-hover:text-[#fafafa] transition-colors">
                {stat.label}
              </span>
            </Link>
          );
        })}
      </motion.div>
    </section>
  );
}
