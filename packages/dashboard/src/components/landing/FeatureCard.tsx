'use client';

import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface FeatureCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  className?: string;
  delay?: number;
  glowColor?: string;
}

export function FeatureCard({
  title,
  description,
  icon,
  className = '',
  delay = 0,
  glowColor = '#00ff88',
}: FeatureCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ duration: 0.5, delay }}
      className={`group relative ${className}`}
    >
      <div
        className="absolute -inset-[1px] rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-md"
        style={{ background: `radial-gradient(circle at center, ${glowColor}30, transparent 70%)` }}
      />

      <div className="relative h-full bg-[#111111] rounded-2xl border border-[#262626] p-6 overflow-hidden group-hover:border-[#333333] transition-colors duration-300">
        <div
          className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
          style={{
            background: `radial-gradient(circle at 50% 0%, ${glowColor}08, transparent 50%)`,
          }}
        />

        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-[1px] bg-gradient-to-r from-transparent via-[#00ff88]/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

        <div className="relative z-10">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-all duration-300 group-hover:scale-110"
            style={{
              background: `linear-gradient(135deg, ${glowColor}15, ${glowColor}05)`,
              border: `1px solid ${glowColor}30`,
            }}
          >
            <div style={{ color: glowColor }}>{icon}</div>
          </div>

          <h3 className="text-lg font-semibold text-[#fafafa] mb-2">{title}</h3>
          <p className="text-sm text-[#a1a1a1] leading-relaxed">{description}</p>
        </div>
      </div>
    </motion.div>
  );
}
