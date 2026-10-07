import { code } from '../code.js';
import { hasFeature } from '../spec.js';
import { cogitatorVersion } from '../versions.js';
import type { FeatureModule } from './types.js';

export const SANDBOX_IMAGE = 'python:3.13-alpine';

const RUN_PYTHON_TS = code`
  import { tool } from '@cogitator-ai/core';
  import { z } from 'zod';

  /**
   * Runs a shell command, usually \`python3 -c '...'\`, in a throwaway Docker
   * container: no network, 256 MB of memory, 30 seconds. Without Docker the
   * call fails instead of running on your machine, because cogitator.yml sets
   * sandbox.allowNativeFallback to false.
   */
  export const runPython = tool({
    name: 'run_python',
    description:
      'Run Python in an isolated container without network access, for calculations, data processing and checking code. Pass a shell command such as python3 -c "print(2 ** 100)" and print what you need: stdout and stderr come back.',
    parameters: z.object({
      command: z.string().min(1).max(10_000).describe('The shell command to run, e.g. python3 -c "print(1 + 1)"'),
    }),
    sandbox: {
      type: 'docker',
      image: '${SANDBOX_IMAGE}',
      resources: { memory: '256MB', cpus: 1 },
      network: { mode: 'none' },
      timeout: 30_000,
    },
    timeout: 40_000,
    execute: async ({ command }) => command,
  });
`;

const SANDBOX_TEST_TS = code`
  import { execFileSync } from 'node:child_process';
  import { describe, expect, it } from 'vitest';
  import { runPython } from '../src/tools/run-python.js';
  import { mockCogitator } from './helpers.js';

  function hasDocker(): boolean {
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  describe('run_python', () => {
    it('runs in a container without network and with limits', () => {
      expect(runPython.sandbox).toMatchObject({ type: 'docker', network: { mode: 'none' } });
      expect(runPython.sandbox?.resources?.memory).toBe('256MB');
    });

    it.runIf(hasDocker())('runs Python and returns its output', async () => {
      const { cogitator } = mockCogitator();
      try {
        const result = await cogitator.invokeTool(runPython, { command: 'python3 -c "print(6 * 7)"' });
        expect(JSON.stringify(result.result)).toContain('42');
      } finally {
        await cogitator.close();
      }
    }, 120_000);
  });
`;

/** Code the assistant writes runs in a Docker container, never on the host. */
export const sandboxFeature: FeatureModule = {
  id: 'feature:sandbox',
  applies: (spec) => hasFeature(spec, 'sandbox'),
  apply(project) {
    project
      .dependency('@cogitator-ai/sandbox', cogitatorVersion('@cogitator-ai/sandbox'))
      .file('src/tools/run-python.ts', RUN_PYTHON_TS)
      .file('tests/sandbox.test.ts', SANDBOX_TEST_TS)
      .tool('runPython', './run-python.js')
      .yml('sandbox', ['allowNativeFallback: false'])
      .instruct(
        'For calculations and data work beyond the calculator, write Python and run it with run_python.'
      );
    project.section(
      'Sandbox',
      code`
        \`src/tools/run-python.ts\` gives the assistant \`run_python\`: a command in a throwaway \`${SANDBOX_IMAGE}\` container without network, with 256 MB of memory and 30 seconds, through \`@cogitator-ai/sandbox\`. Docker has to run. Without it the call fails, since \`sandbox.allowNativeFallback: false\` in \`cogitator.yml\` keeps the code off your machine.
      `
    );
  },
};
