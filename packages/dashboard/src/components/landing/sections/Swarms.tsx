import type { ReactNode } from 'react';
import { highlightCode } from '../highlight';
import { Section, SectionHeader } from '../ui';
import { SCENES, type StrategyId } from './swarms/scenes';
import { SwarmShowcase } from './swarms/SwarmShowcase';
import { SWARM_SNIPPETS } from './swarms/snippets';

export async function SwarmsSection() {
  const highlighted = await Promise.all(
    SCENES.map(async (scene) => [scene.id, await highlightCode(SWARM_SNIPPETS[scene.id])] as const)
  );
  const snippets = Object.fromEntries(highlighted) as Record<StrategyId, ReactNode>;

  return (
    <Section id="swarms">
      <SectionHeader
        eyebrow="Swarms"
        title={
          <>
            Seven ways to make agents work together.{' '}
            <span className="text-l-muted">One config key.</span>
          </>
        }
        description="A supervisor over workers, a jury that votes, an auction for the task, stages behind a quality gate, two agents arguing it out — and every agent on the model that suits its role."
      />
      <SwarmShowcase snippets={snippets} />
    </Section>
  );
}
