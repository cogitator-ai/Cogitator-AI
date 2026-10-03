'use client';

import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Animation features for the landing's `m` components. `domAnimation` covers enter/exit, keyframes
 * and gestures; the few demos that animate layout load `domMax` in their own lazy chunks.
 * Transform animations are skipped for visitors who prefer reduced motion.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
