'use client';

import { useState, useEffect, useCallback } from 'react';

interface ParallaxPosition {
  x: number;
  y: number;
}

export function useMouseParallax(sensitivity: number = 0.02): ParallaxPosition {
  const [position, setPosition] = useState<ParallaxPosition>({ x: 0, y: 0 });

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const x = (e.clientX - centerX) * sensitivity;
      const y = (e.clientY - centerY) * sensitivity;
      setPosition({ x, y });
    },
    [sensitivity]
  );

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [handleMouseMove]);

  return position;
}
