import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExamplesIndex } from './examples-index.ts';
import { readWorkspaceVersions } from './workspace-versions.ts';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The compile-time constants `src/kit/versions.ts` reads, for tsup and vitest. */
export function scaffolderDefines(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
    version: string;
  };
  return {
    __COGITATOR_VERSIONS__: JSON.stringify(readWorkspaceVersions()),
    __SCAFFOLDER_VERSION__: JSON.stringify(manifest.version),
    __COGITATOR_EXAMPLES__: JSON.stringify(readExamplesIndex()),
    __TELEMETRY_WEBSITE_ID__: JSON.stringify(process.env.COGITATOR_UMAMI_WEBSITE_ID ?? ''),
  };
}
