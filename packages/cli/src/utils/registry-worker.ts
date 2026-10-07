import { join } from 'node:path';
import { loadProjectEnv } from './doctor.js';
import { importUserModule } from './module-loader.js';
import { describeRegistry, REGISTRY_PATH, type InspectionMessage } from './registry.js';

/**
 * Runs in a child process of `inspectRegistry`: imports the project's
 * registry, sends its description to the parent and exits.
 */
async function main(): Promise<void> {
  const projectDir = process.argv[2] ?? process.cwd();
  let message: InspectionMessage;
  let module: Record<string, unknown> | undefined;
  try {
    loadProjectEnv(projectDir);
    module = await importUserModule(join(projectDir, REGISTRY_PATH), projectDir);
    message = { ok: true, registry: describeRegistry(module) };
  } catch (error) {
    message = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  await new Promise<void>((resolve) => process.send?.(message, () => resolve()) ?? resolve());
  const runtime = module?.cogitator;
  if (
    typeof runtime === 'object' &&
    runtime !== null &&
    'close' in runtime &&
    typeof runtime.close === 'function'
  ) {
    await Promise.race([
      (runtime.close as () => Promise<void>)().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
  }
  process.exit(0);
}

void main();
