'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Github, Cpu } from 'lucide-react';
import { TerminalDemo } from './TerminalDemo';

interface HeroProps {
  onGetStarted: () => void;
}

export function Hero({ onGetStarted }: HeroProps) {
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
          Self-hosted.{' '}
          <span className="text-[#fafafa]">Production-grade.</span>{' '}
          TypeScript-native.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onGetStarted}
            className="group relative px-8 py-4 bg-[#00ff88] text-[#0a0a0a] rounded-xl font-semibold text-lg overflow-hidden"
          >
            <span className="relative z-10 flex items-center gap-2">
              Get Started
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </span>
            <motion.div
              className="absolute inset-0 bg-gradient-to-r from-[#00ff88] to-[#00ddaa]"
              animate={{
                x: ['0%', '100%', '0%'],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                ease: 'linear',
              }}
              style={{ width: '200%', marginLeft: '-50%' }}
            />
          </motion.button>

          <motion.a
            href="https://github.com/eL1fe/cogitator"
            target="_blank"
            rel="noopener noreferrer"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="group flex items-center gap-2 px-8 py-4 bg-transparent border border-[#333333] text-[#fafafa] rounded-xl font-semibold text-lg hover:border-[#00ff88]/50 hover:bg-[#00ff88]/5 transition-all"
          >
            <Github className="w-5 h-5" />
            View on GitHub
          </motion.a>
        </div>
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
