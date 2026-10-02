import type { TemplateFile } from '../../types.js';

/**
 * pnpm 10.26+ skips dependency build scripts unless they are allowed, and pnpm 11 fails the
 * install instead. These are the native/binary packages a Cogitator project pulls in.
 */
export const PNPM_ALLOWED_BUILDS = ['better-sqlite3', 'esbuild', 'sharp'] as const;

export function generatePnpmWorkspace(): TemplateFile {
  return {
    path: 'pnpm-workspace.yaml',
    content: ['allowBuilds:', ...PNPM_ALLOWED_BUILDS.map((name) => `  ${name}: true`), ''].join(
      '\n'
    ),
  };
}
