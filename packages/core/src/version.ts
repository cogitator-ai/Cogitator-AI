import { builtinModule } from './utils/env';

let cached: { version: string | undefined } | undefined;

/**
 * The version of `@cogitator-ai/core` from its `package.json`, read on the first call. Undefined
 * where the runtime cannot read it (Deno without `--allow-read`, edge runtimes without Node
 * modules), so importing the core never touches the filesystem.
 */
export function coreVersion(): string | undefined {
  cached ??= { version: readCoreVersion() };
  return cached.version;
}

function readCoreVersion(): string | undefined {
  try {
    const nodeModule = builtinModule<typeof import('node:module')>('node:module');
    if (!nodeModule) return undefined;
    const manifest: unknown = nodeModule.createRequire(import.meta.url)('../package.json');
    return typeof manifest === 'object' &&
      manifest !== null &&
      'version' in manifest &&
      typeof manifest.version === 'string'
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}
