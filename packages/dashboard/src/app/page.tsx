'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  BackgroundGrid,
  Hero,
  FeaturesGrid,
  AuthSection,
  Footer,
} from '@/components/landing';

function LandingContent() {
  const [showAuth, setShowAuth] = useState(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('auth') === 'login') {
      setShowAuth(true);
    }
  }, [searchParams]);

  return (
    <>
      <div className="relative z-10">
        <Hero onGetStarted={() => setShowAuth(true)} />
        <FeaturesGrid />
        <Footer />
      </div>

      <AuthSection isOpen={showAuth} onClose={() => setShowAuth(false)} />
    </>
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
          0%, 100% {
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
