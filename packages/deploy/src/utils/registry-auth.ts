import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.js';

const DOCKER_HUB_KEYS = ['https://index.docker.io/v1/', 'index.docker.io', 'docker.io'];

export function registryHost(registry: string): string {
  const withoutScheme = registry.replace(/^https?:\/\//, '');
  const first = withoutScheme.split('/')[0] ?? '';
  const looksLikeHost = first.includes('.') || first.includes(':') || first === 'localhost';
  return looksLikeHost ? first : 'docker.io';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostMatches(key: string, host: string): boolean {
  const normalized = key.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (host === 'docker.io') {
    return DOCKER_HUB_KEYS.includes(key) || DOCKER_HUB_KEYS.includes(normalized);
  }
  return normalized === host;
}

function helperHasCredentials(helper: string, host: string): boolean {
  const result = run(`docker-credential-${helper}`, ['list'], { timeout: 5_000 });
  if (!result.success) return false;
  try {
    const parsed: unknown = JSON.parse(result.output);
    return isRecord(parsed) && Object.keys(parsed).some((key) => hostMatches(key, host));
  } catch {
    return false;
  }
}

/**
 * Determine whether Docker has stored credentials for the registry, by reading
 * the Docker CLI config (`auths`, `credHelpers`, `credsStore`).
 */
export function isRegistryAuthenticated(
  registry: string,
  dockerConfigDir = process.env.DOCKER_CONFIG ?? join(homedir(), '.docker')
): boolean {
  const configPath = join(dockerConfigDir, 'config.json');
  if (!existsSync(configPath)) return false;

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return false;
  }
  if (!isRecord(config)) return false;

  const host = registryHost(registry);
  const auths = isRecord(config.auths) ? config.auths : {};
  const authKeys = Object.keys(auths).filter((key) => hostMatches(key, host));

  const credHelpers = isRecord(config.credHelpers) ? config.credHelpers : {};
  const helperKey = Object.keys(credHelpers).find((key) => hostMatches(key, host));
  if (helperKey) {
    const helper = credHelpers[helperKey];
    return typeof helper === 'string' && helperHasCredentials(helper, host);
  }

  const inlineAuth = authKeys.some((key) => {
    const entry = auths[key];
    return (
      isRecord(entry) && (typeof entry.auth === 'string' || typeof entry.identitytoken === 'string')
    );
  });
  if (inlineAuth) return true;

  if (typeof config.credsStore === 'string') {
    return helperHasCredentials(config.credsStore, host);
  }

  return false;
}
