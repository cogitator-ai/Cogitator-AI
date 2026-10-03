interface NodeLikeProcess {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
}

function nodeProcess(): NodeLikeProcess | undefined {
  return (globalThis as { process?: NodeLikeProcess }).process;
}

/**
 * An environment variable, or undefined where the runtime has no `process.env`
 * (Cloudflare Workers without `nodejs_compat`) or forbids reading it (Deno
 * without `--allow-env`).
 */
export function readEnv(name: string): string | undefined {
  try {
    return nodeProcess()?.env?.[name];
  } catch {
    return undefined;
  }
}

/** A Node built-in module where the runtime provides one, else undefined. */
export function builtinModule<T>(id: string): T | undefined {
  try {
    return nodeProcess()?.getBuiltinModule?.(id) as T | undefined;
  } catch {
    return undefined;
  }
}
