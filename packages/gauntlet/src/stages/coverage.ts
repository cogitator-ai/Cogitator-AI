import { publishedPackages } from '../packages.js';
import type { StageDefinition } from '../runner/types.js';

/**
 * Fails when a published package is exercised by no stage, so a new package cannot be released
 * without being wired into the gauntlet.
 */
export function coverageStage(stages: StageDefinition[]): StageDefinition {
  return {
    id: 'coverage',
    title: 'Package coverage',
    description: 'Every published package is exercised by at least one stage of the gauntlet.',
    packages: [],
    timeoutMs: 10_000,
    async run(ctx) {
      const published = publishedPackages();
      const covered = new Set(stages.flatMap((stage) => stage.packages));

      await ctx.check('every published package is exercised', (evidence) => {
        const missing = published.filter((name) => !covered.has(name));
        evidence('published', published.length);
        evidence('covered', published.length - missing.length);
        if (missing.length) evidence('missing', missing);
        if (missing.length) {
          throw new Error(`No stage exercises: ${missing.join(', ')}`);
        }
      });

      await ctx.check('stages name only real packages', (evidence) => {
        const unknown = [...covered].filter((name) => !published.includes(name));
        if (unknown.length) evidence('unknown', unknown);
        if (unknown.length) throw new Error(`Unknown package names: ${unknown.join(', ')}`);
      });
    },
  };
}
