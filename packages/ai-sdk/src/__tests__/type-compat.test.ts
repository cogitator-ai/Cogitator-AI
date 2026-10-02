import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

describe('default model types per installed ai major', () => {
  it.each(['4', '5', '6', '7'])(
    'type-checks default and explicit models against ai@%s',
    (major) => {
      const run = () =>
        execFileSync(
          process.execPath,
          [tsc, '-p', join(packageRoot, 'type-tests', `tsconfig.ai-v${major}.json`)],
          { cwd: packageRoot, encoding: 'utf8', stdio: 'pipe' }
        );
      expect(run).not.toThrow();
    },
    120_000
  );
});
