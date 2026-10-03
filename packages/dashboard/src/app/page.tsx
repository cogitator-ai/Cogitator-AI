import { ConsoleGreeting } from '@/components/landing/ConsoleGreeting';
import { Footer, FinalCta } from '@/components/landing/Footer';
import { Hero } from '@/components/landing/Hero';
import { LogoMarquee } from '@/components/landing/LogoMarquee';
import { Nav } from '@/components/landing/Nav';
import { AgentFriendlySection } from '@/components/landing/sections/AgentFriendly';
import { FeatureExplorerSection } from '@/components/landing/sections/FeatureExplorer';
import { RunsAnywhereSection } from '@/components/landing/sections/RunsAnywhere';
import { SwarmsSection } from '@/components/landing/sections/Swarms';
import { WorkflowsSection } from '@/components/landing/sections/Workflows';

export default function LandingPage() {
  return (
    <div className="dark landing-noise relative min-h-screen overflow-x-clip bg-l-bg text-l-text [color-scheme:dark]">
      <ConsoleGreeting />
      <Nav />
      <main>
        <Hero />
        <LogoMarquee />
        <WorkflowsSection />
        <SwarmsSection />
        <FeatureExplorerSection />
        <RunsAnywhereSection />
        <AgentFriendlySection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
