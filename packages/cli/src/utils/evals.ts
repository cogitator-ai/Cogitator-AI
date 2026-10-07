import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PROVIDER_ENV, preferredEnvName } from '@cogitator-ai/config';
import type { CogitatorConfig } from '@cogitator-ai/types';

const EVAL_FILE = /\.eval\.(?:ts|mts|js|mjs)$/;

/** What `cogitator eval` needs from an `EvalSuite`, checked at runtime on the default export. */
export interface EvalSuiteLike {
  run(options?: { maxCases?: number; signal?: AbortSignal }): Promise<EvalSuiteResultLike>;
}

export interface EvalSuiteResultLike {
  assertions: Array<{ name: string; passed: boolean; message: string }>;
  aggregated: Record<string, { name: string; mean: number }>;
  stats: { total: number; errors: number; duration: number; cost: number };
  report(type: 'console' | 'json', options?: { path?: string }): void;
}

export function isEvalSuite(value: unknown): value is EvalSuiteLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  );
}

/** The eval files under `dir`, `*.eval.ts` and friends, sorted for a stable order. */
export function findEvalFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (EVAL_FILE.test(entry)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** The eval files to run: the arguments as given, or every file under `evals/`. */
export function resolveEvalFiles(projectDir: string, args: readonly string[]): string[] {
  if (args.length === 0) return findEvalFiles(join(projectDir, 'evals'));
  return args.flatMap((arg) => {
    const full = resolve(projectDir, arg);
    if (!existsSync(full)) throw new Error(`No eval file or directory at ${arg}`);
    return statSync(full).isDirectory() ? findEvalFiles(full) : [full];
  });
}

/**
 * The credential the default model is missing, or undefined when its provider
 * has everything it needs. Evals call the model, so without a key they cannot
 * run, and CI on a fork without secrets skips them instead of failing.
 */
export function missingCredential(config: CogitatorConfig): string | undefined {
  const model = config.llm?.defaultModel;
  const provider = model?.includes('/') ? model.split('/')[0] : config.llm?.defaultProvider;
  if (!provider || !(provider in PROVIDER_ENV)) return undefined;
  const settings = PROVIDER_ENV[provider as keyof typeof PROVIDER_ENV];
  const configured = config.llm?.providers?.[provider as keyof typeof PROVIDER_ENV] as
    Record<string, unknown> | undefined;
  for (const setting of settings) {
    if (!setting.required) continue;
    if (setting.sdkEnv?.some((name) => process.env[name])) continue;
    const value = configured?.[setting.field];
    if (value === undefined || value === '') return preferredEnvName(setting);
  }
  return undefined;
}

export interface SuiteOutcome {
  file: string;
  passed: boolean;
  stats: EvalSuiteResultLike['stats'];
  metrics: Record<string, number>;
  assertions: EvalSuiteResultLike['assertions'];
}

/** Whether a finished suite counts as passed: every assertion holds and not every case failed. */
export function suitePassed(result: EvalSuiteResultLike): boolean {
  const allErrored = result.stats.total > 0 && result.stats.errors === result.stats.total;
  return !allErrored && result.assertions.every((assertion) => assertion.passed);
}

export function outcomeOf(
  projectDir: string,
  file: string,
  result: EvalSuiteResultLike
): SuiteOutcome {
  return {
    file: relative(projectDir, file),
    passed: suitePassed(result),
    stats: result.stats,
    metrics: Object.fromEntries(
      Object.entries(result.aggregated).map(([name, m]) => [name, m.mean])
    ),
    assertions: result.assertions,
  };
}
