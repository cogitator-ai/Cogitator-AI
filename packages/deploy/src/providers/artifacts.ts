import type { GeneratedArtifacts, PreflightCheck } from '@cogitator-ai/types';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCKERIGNORE } from '../generator.js';

/**
 * Write generated artifacts into the project's artifacts directory. A root
 * `.dockerignore` is created when the project has none, so `.env` files and
 * `node_modules` never end up in the image build context.
 */
export function writeArtifacts(projectDir: string, artifacts: GeneratedArtifacts): string {
  const outputDir = join(projectDir, artifacts.outputDir);
  mkdirSync(outputDir, { recursive: true });

  for (const file of artifacts.files) {
    writeFileSync(join(outputDir, file.path), file.content);
  }

  const rootIgnore = join(projectDir, '.dockerignore');
  if (!existsSync(rootIgnore)) {
    writeFileSync(rootIgnore, DOCKERIGNORE);
  }

  return outputDir;
}

export function secretChecks(secrets: readonly string[], env: NodeJS.ProcessEnv): PreflightCheck[] {
  return secrets.map((secret) => {
    const isSet = !!env[secret];
    return {
      name: `Secret: ${secret}`,
      passed: isSet,
      message: isSet ? `${secret} is set` : `${secret} is not set`,
      fix: isSet ? undefined : `Add ${secret} to .env or export ${secret}=<value>`,
    };
  });
}
