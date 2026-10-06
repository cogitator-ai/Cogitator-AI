import type { LLMProvider, TemplateFile } from '../types.js';

/** `value` as a single-quoted TypeScript string literal, safe for any project name. */
export function tsString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\p{Zl}/gu, '\\u2028')
    .replace(/\p{Zp}/gu, '\\u2029');
  return `'${escaped}'`;
}

/** Whether the provider needs an API key, which script templates read through `requireEnv`. */
function needsApiKey(provider: LLMProvider): boolean {
  return provider !== 'ollama';
}

/** `src/env.ts` with the `requireEnv` helper, for providers that need an API key. */
export function envHelperFiles(provider: LLMProvider): TemplateFile[] {
  if (!needsApiKey(provider)) return [];
  const content = [
    `export function requireEnv(name: string): string {`,
    `  const value = process.env[name]`,
    `  if (!value) {`,
    `    throw new Error(\`\${name} is not set. Copy .env.example to .env and fill it in.\`)`,
    `  }`,
    `  return value`,
    `}`,
    ``,
  ].join('\n');
  return [{ path: 'src/env.ts', content }];
}

/** The import of `requireEnv` for the file that builds the `Cogitator`, if it needs one. */
export function envHelperImport(provider: LLMProvider): string[] {
  return needsApiKey(provider) ? [`import { requireEnv } from './env.js'`] : [];
}

/** Runs `main()` and turns a failure into a non-zero exit code. */
export const RUN_MAIN = [
  `main().catch((error: unknown) => {`,
  `  console.error(error)`,
  `  process.exitCode = 1`,
  `})`,
  ``,
];

/** The scripts of the templates that run `src/index.ts` with tsx, loading `.env` when it exists. */
export function scriptTemplateScripts(): Record<string, string> {
  return {
    dev: 'tsx watch --env-file-if-exists=.env src/index.ts',
    start: 'tsx --env-file-if-exists=.env src/index.ts',
    build: 'tsc',
    typecheck: 'tsc --noEmit',
  };
}

/** The dev dependencies of the templates that run `src/index.ts` with tsx. */
export function scriptTemplateDevDependencies(): Record<string, string> {
  return {
    typescript: '^5.8.0',
    tsx: '^4.19.0',
    '@types/node': '^22.0.0',
  };
}
