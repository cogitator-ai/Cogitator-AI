'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';

const glitchChars = '!@#$%^&*()_+-=[]{}|;:,.<>?~`';

function GlitchText({ text }: { text: string }) {
  const [displayText, setDisplayText] = useState(text);
  const [isGlitching, setIsGlitching] = useState(false);

  useEffect(() => {
    const glitchInterval = setInterval(() => {
      setIsGlitching(true);
      let iterations = 0;
      const maxIterations = 10;

      const scramble = setInterval(() => {
        setDisplayText(
          text
            .split('')
            .map((char, i) => {
              if (char === ' ') return ' ';
              if (iterations > i) return text[i];
              return glitchChars[Math.floor(Math.random() * glitchChars.length)];
            })
            .join('')
        );

        iterations++;
        if (iterations > maxIterations) {
          clearInterval(scramble);
          setDisplayText(text);
          setIsGlitching(false);
        }
      }, 50);
    }, 3000);

    return () => clearInterval(glitchInterval);
  }, [text]);

  return (
    <span className={isGlitching ? 'text-[#00ff88]' : ''}>
      {displayText}
    </span>
  );
}

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(0,255,136,0.03),transparent_70%)]" />

      <div
        className="absolute inset-0 opacity-[0.015]"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0,255,136,0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,255,136,0.1) 1px, transparent 1px)
          `,
          backgroundSize: '50px 50px',
        }}
      />

      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#00ff88]/5 rounded-full blur-[100px] animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-[#00aaff]/5 rounded-full blur-[80px] animate-pulse" style={{ animationDelay: '1s' }} />

      <div className="relative z-10 text-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <div className="relative mb-8">
            <h1 className="text-[12rem] md:text-[16rem] font-black text-transparent bg-clip-text bg-gradient-to-b from-[#333] to-[#1a1a1a] leading-none select-none">
              404
            </h1>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[12rem] md:text-[16rem] font-black text-[#00ff88]/10 blur-xl">
                404
              </span>
            </div>
            <motion.div
              className="absolute inset-0 flex items-center justify-center"
              animate={{
                opacity: [0.5, 1, 0.5],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: 'easeInOut',
              }}
            >
              <span className="text-8xl md:text-9xl font-mono text-[#00ff88] tracking-wider">
                <GlitchText text="404" />
              </span>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="space-y-4 mb-12"
          >
            <h2 className="text-2xl md:text-3xl font-bold text-[#fafafa]">
              Page Not Found
            </h2>
            <p className="text-[#a1a1a1] max-w-md mx-auto font-mono text-sm">
              <span className="text-[#ff4444]">Error:</span> The requested resource could not be located.
              <br />
              <span className="text-[#666]">// Check the URL or navigate back home</span>
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="flex flex-col sm:flex-row gap-4 justify-center"
          >
            <Link
              href="/"
              className="group relative px-8 py-3 bg-[#00ff88] text-[#0a0a0a] font-semibold rounded-lg overflow-hidden transition-all hover:shadow-[0_0_30px_rgba(0,255,136,0.3)]"
            >
              <span className="relative z-10">Go Home</span>
              <div className="absolute inset-0 bg-gradient-to-r from-[#00ff88] to-[#00cc6a] opacity-0 group-hover:opacity-100 transition-opacity" />
            </Link>
            <Link
              href="/docs"
              className="px-8 py-3 border border-[#333] text-[#fafafa] font-semibold rounded-lg hover:border-[#00ff88] hover:text-[#00ff88] transition-all"
            >
              View Docs
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="mt-16 font-mono text-xs text-[#444] space-y-1"
          >
            <p>$ curl -I {typeof window !== 'undefined' ? window.location.href : '/unknown'}</p>
            <p className="text-[#ff4444]">HTTP/1.1 404 Not Found</p>
            <p>X-Powered-By: Cogitator</p>
          </motion.div>
        </motion.div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-[#00ff88]/50 to-transparent" />
    </div>
  );
}
