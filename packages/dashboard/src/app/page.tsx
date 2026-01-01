'use client';

import { Suspense } from 'react';
import { BackgroundGrid, Hero, FeaturesGrid, Footer } from '@/components/landing';

function LandingContent() {
  return (
    <div className="relative z-10">
      <Hero />
      <FeaturesGrid />
      <Footer />
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[#0a0a0a] overflow-x-hidden">
      <BackgroundGrid />

      <Suspense fallback={null}>
        <LandingContent />
      </Suspense>

      <style jsx global>{`
        @keyframes gradient {
          0%,
          100% {
            background-position: 0% 50%;
          }
          50% {
            background-position: 100% 50%;
          }
        }

        .animate-gradient {
          background-size: 200% 200%;
          animation: gradient 5s ease infinite;
        }
      `}</style>
    </div>
  );
}
