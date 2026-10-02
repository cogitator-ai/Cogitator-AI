import { join } from 'node:path';
import { loadDotenvFile } from '@cogitator-ai/config';

/**
 * Environment visible to a deployment: the project's `.env` file, overridden by
 * variables already present in the current process.
 */
export function resolveDeployEnv(projectDir: string): NodeJS.ProcessEnv {
  return { ...loadDotenvFile(join(projectDir, '.env')), ...process.env };
}

export function sanitizeName(value: string, fallback = 'cogitator-app'): string {
  const cleaned = value
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return /^[a-z0-9]/.test(cleaned) ? cleaned : fallback;
}
