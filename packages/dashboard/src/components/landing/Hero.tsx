'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Github, Cpu, Construction, Rocket } from 'lucide-react';
import { TerminalDemo } from './TerminalDemo';

export function Hero() {
  const [showWipTooltip, setShowWipTooltip] = useState(false);

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

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <div className="relative">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => setShowWipTooltip(true)}
              onMouseEnter={() => setShowWipTooltip(true)}
              onMouseLeave={() => setShowWipTooltip(false)}
              className="group relative px-8 py-4 bg-[#333333] text-[#666666] rounded-xl font-semibold text-lg overflow-hidden cursor-not-allowed"
            >
              <span className="relative z-10 flex items-center gap-2">
                <Construction className="w-5 h-5" />
                Dashboard Coming Soon
              </span>
            </motion.button>

            <AnimatePresence>
              {showWipTooltip && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute left-1/2 -translate-x-1/2 top-full mt-3 w-72 p-4 bg-[#1a1a1a] border border-[#333333] rounded-xl shadow-xl z-50"
                >
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-[#1a1a1a] border-l border-t border-[#333333] rotate-45" />
                  <div className="relative z-10">
                    <div className="flex items-center gap-2 text-[#00ff88] mb-2">
                      <Construction className="w-4 h-4" />
                      <span className="font-semibold text-sm">Work in Progress</span>
                    </div>
                    <p className="text-sm text-[#a1a1a1]">
                      The dashboard is under active development. Star us on GitHub to get notified
                      when it&apos;s ready!
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

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
