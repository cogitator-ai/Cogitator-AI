'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowRight, BookOpen, Bot, Cpu, Rocket } from 'lucide-react';
import { GithubIcon } from '@/components/icons/GithubIcon';
import { DOCS_HOME, GET_STARTED_URL, GITHUB_URL, LLMS_TXT_URL, SITE_URL } from '@/lib/site';
import { TerminalDemo } from './TerminalDemo';

export function Hero() {
  const llmsTxtLabel = `${new URL(SITE_URL).host}${LLMS_TXT_URL}`;

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 py-20">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="text-center max-w-4xl mx-auto mb-12"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#00ff88]/10 border border-[#00ff88]/30 rounded-full text-sm text-[#00ff88] mb-8"
        >
          <Cpu className="w-4 h-4" />
          <span>Open Source AI Agent Framework</span>
        </motion.div>

        <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">
          <span className="text-[#fafafa]">Kubernetes for</span>
          <br />
          <span className="relative">
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#00ff88] via-[#00ddaa] to-[#00aaff] animate-gradient">
              AI Agents
            </span>
            <motion.span
              className="absolute -inset-1 bg-gradient-to-r from-[#00ff88]/20 to-[#00aaff]/20 blur-2xl -z-10"
              animate={{
                opacity: [0.5, 0.8, 0.5],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            />
          </span>
        </h1>

        <p className="text-xl md:text-2xl text-[#a1a1a1] mb-10 font-light">
          Self-hosted. <span className="text-[#fafafa]">Production-grade.</span> TypeScript-native.
        </p>

        <div className="flex flex-col sm:flex-row sm:flex-wrap items-center justify-center gap-4">
          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
            <Link
              href={GET_STARTED_URL}
              className="group relative flex items-center gap-2 px-8 py-4 bg-[#00ff88] text-[#0a0a0a] rounded-xl font-semibold text-lg overflow-hidden transition-shadow hover:shadow-[0_0_30px_rgba(0,255,136,0.3)]"
            >
              <span className="relative z-10 flex items-center gap-2">
                Get Started
                <ArrowRight className="w-5 h-5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </motion.div>

          <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
            <Link
              href={DOCS_HOME}
              className="group flex items-center gap-2 px-8 py-4 bg-transparent border border-[#333333] text-[#fafafa] rounded-xl font-semibold text-lg hover:border-[#00ff88]/50 hover:bg-[#00ff88]/5 transition-all"
            >
              <BookOpen className="w-5 h-5" />
              Docs
            </Link>
          </motion.div>

          <motion.a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="group flex items-center gap-2 px-8 py-4 bg-transparent border border-[#333333] text-[#fafafa] rounded-xl font-semibold text-lg hover:border-[#00ff88]/50 hover:bg-[#00ff88]/5 transition-all"
          >
            <GithubIcon className="w-5 h-5" />
            View on GitHub
          </motion.a>

          <motion.a
            href="https://www.producthunt.com/posts/cogitator?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-cogitator"
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="group flex items-center gap-2 px-8 py-4 bg-transparent border border-[#333333] text-[#fafafa] rounded-xl font-semibold text-lg hover:border-[#ff6154]/50 hover:bg-[#ff6154]/5 transition-all"
          >
            <Rocket className="w-5 h-5 text-[#ff6154]" />
            Product Hunt
          </motion.a>
        </div>

        <motion.a
          href={LLMS_TXT_URL}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.6 }}
          className="group mt-8 inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-[#a1a1a1] hover:text-[#fafafa] transition-colors"
        >
          <Bot className="w-4 h-4 text-[#00aaff]" />
          <span>Agent-friendly docs — point your coding agent at</span>
          <code className="font-mono text-[#00ff88] group-hover:underline underline-offset-4">
            {llmsTxtLabel}
          </code>
        </motion.a>
      </motion.div>

      <TerminalDemo />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.5, duration: 1 }}
        className="absolute bottom-10 left-1/2 -translate-x-1/2"
      >
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="w-6 h-10 rounded-full border-2 border-[#333333] flex items-start justify-center p-2"
        >
          <motion.div
            animate={{ opacity: [0.5, 1, 0.5], y: [0, 8, 0] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-1.5 h-1.5 rounded-full bg-[#00ff88]"
          />
        </motion.div>
      </motion.div>
    </section>
  );
}
