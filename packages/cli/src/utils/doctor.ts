import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { findConfigFile, loadConfig, parseDotenv } from '@cogitator-ai/config';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { checkApiKey, describeKeyCheck, PROVIDER_INFO } from 'create-cogitator-app';
import { listOllamaModels, resolveOllamaUrl } from './ollama.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

export interface DoctorContext {
  projectDir: string;
  /** The environment as the project sees it, `.env` loaded. */
  env: Record<string, string | undefined>;
  nodeVersion: string;
  /** Network and service probes; off in tests that only check the project files. */
  probe: boolean;
  fetch?: typeof fetch;
}

interface PackageManifest {
  engines?: { node?: string; bun?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function readManifest(projectDir: string): PackageManifest | undefined {
  const path = join(projectDir, 'package.json');
  if (!existsSync(path)) return undefined;
  const parsed = readJson(path);
  return typeof parsed === 'object' && parsed !== null ? (parsed as PackageManifest) : undefined;
}

/** Fills `env` with the variables of the project's `.env` that it does not set already. */
export function loadProjectEnv(
  projectDir: string,
  env: Record<string, string | undefined> = process.env
): void {
  const file = join(projectDir, '.env');
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseDotenv(readFileSync(file, 'utf-8')))) {
    if (env[key] === undefined) env[key] = value;
  }
}

/** Whether `version` (like `v22.23.1`) satisfies a `>=x.y.z` range, the only form engines use here. */
export function satisfiesMinimum(version: string, range: string): boolean {
  const minimum = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  const actual = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!minimum || !actual) return true;
  for (let i = 1; i <= 3; i++) {
    const a = Number(actual[i]);
    const m = Number(minimum[i]);
    if (a !== m) return a > m;
  }
  return true;
}

/** Variables `.env.example` lists without a leading `#`: the ones the project requires. */
export function requiredVariables(projectDir: string): string[] {
  const path = join(projectDir, '.env.example');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

function nodeCheck(manifest: PackageManifest | undefined, nodeVersion: string): DoctorCheck {
  const range = manifest?.engines?.node;
  if (!range) {
    return { id: 'node', label: 'Node.js', status: 'pass', detail: nodeVersion };
  }
  return satisfiesMinimum(nodeVersion, range)
    ? { id: 'node', label: 'Node.js', status: 'pass', detail: `${nodeVersion} (needs ${range})` }
    : {
        id: 'node',
        label: 'Node.js',
        status: 'fail',
        detail: `${nodeVersion}, but the project needs ${range}`,
        fix: 'install a newer Node.js, for example with nvm or fnm',
      };
}

/** The part of Yarn's Plug'n'Play API (pnpapi) the check reads. */
interface PnpApi {
  findPackageLocator(path: string): { name: string | null; reference: string | null } | null;
  getPackageInformation(locator: { name: string | null; reference: string | null }): {
    packageDependencies: Map<string, string | [string, string] | null>;
  } | null;
}

function isPnpApi(value: unknown): value is PnpApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'findPackageLocator' in value &&
    typeof value.findPackageLocator === 'function' &&
    'getPackageInformation' in value &&
    typeof value.getPackageInformation === 'function'
  );
}

/** The nearest `.pnp.cjs` at or above `directory`, which a Yarn Plug'n'Play install writes. */
function findPnpFile(directory: string): string | undefined {
  for (let current = resolve(directory); ; current = dirname(current)) {
    const candidate = join(current, '.pnp.cjs');
    if (existsSync(candidate)) return candidate;
    if (dirname(current) === current) return undefined;
  }
}

function versionOf(manifestPath: string): string {
  const parsed = readJson(manifestPath);
  return typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
    ? parsed.version
    : '?';
}

/**
 * The version of `name` the project resolves, `undefined` when it is not
 * installed. Plug'n'Play installs are read through Yarn's own API, others the
 * way Node looks packages up: node_modules of the project and every directory
 * above it, so hoisted packages of a monorepo count.
 */
export function installedVersion(projectDir: string, name: string): string | undefined {
  const pnpFile = findPnpFile(projectDir);
  if (pnpFile) {
    let api: unknown;
    try {
      api = createRequire(import.meta.url)(pnpFile);
    } catch {
      return undefined;
    }
    if (!isPnpApi(api)) return undefined;
    const locator = api.findPackageLocator(`${resolve(projectDir)}/`);
    const reference = locator && api.getPackageInformation(locator)?.packageDependencies.get(name);
    if (!reference) return undefined;
    const resolved = Array.isArray(reference) ? reference[1] : reference;
    return /npm:([^#]+)$/.exec(resolved)?.[1] ?? resolved;
  }
  for (let current = resolve(projectDir); ; current = dirname(current)) {
    const manifest = join(current, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) return versionOf(manifest);
    if (dirname(current) === current) return undefined;
  }
}

function packagesCheck(projectDir: string, manifest: PackageManifest | undefined): DoctorCheck {
  const wanted = Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies }).filter(
    (name) => name.startsWith('@cogitator-ai/')
  );
  if (wanted.length === 0) {
    return {
      id: 'packages',
      label: 'Cogitator packages',
      status: 'warn',
      detail: 'package.json depends on none',
    };
  }
  const missing: string[] = [];
  const installed: string[] = [];
  for (const name of wanted) {
    const version = installedVersion(projectDir, name);
    if (version === undefined) missing.push(name);
    else installed.push(`${name.slice('@cogitator-ai/'.length)}@${version}`);
  }
  return missing.length > 0
    ? {
        id: 'packages',
        label: 'Cogitator packages',
        status: 'fail',
        detail: `not installed: ${missing.join(', ')}`,
        fix: 'install the dependencies (pnpm install, npm install, ...)',
      }
    : { id: 'packages', label: 'Cogitator packages', status: 'pass', detail: installed.join(', ') };
}

/**
 * Loads the project's `cogitator.yml` the way the project does. `${VAR}` in it
 * reads `process.env`, so the command loads `.env` into it first.
 */
function configCheck(projectDir: string): { check: DoctorCheck; config?: CogitatorConfig } {
  const path = findConfigFile(projectDir);
  if (!path) {
    return {
      check: {
        id: 'config',
        label: 'cogitator.yml',
        status: 'warn',
        detail: 'not found, the project configures Cogitator in code only',
      },
    };
  }
  try {
    const config = loadConfig({ configPath: path });
    return {
      check: {
        id: 'config',
        label: 'cogitator.yml',
        status: 'pass',
        detail: `model ${config.llm?.defaultModel ?? 'not set'}, memory ${config.memory?.adapter ?? 'none'}`,
      },
      config,
    };
  } catch (error) {
    return {
      check: {
        id: 'config',
        label: 'cogitator.yml',
        status: 'fail',
        detail:
          error instanceof Error ? error.message.split('\n').slice(0, 4).join(' ') : String(error),
        fix: 'fix the reported keys in cogitator.yml',
      },
    };
  }
}

function envCheck(projectDir: string, env: Record<string, string | undefined>): DoctorCheck {
  const required = requiredVariables(projectDir);
  const missing = required.filter((name) => !env[name]?.trim());
  if (required.length === 0) {
    return { id: 'env', label: 'Environment', status: 'pass', detail: 'no variables required' };
  }
  return missing.length > 0
    ? {
        id: 'env',
        label: 'Environment',
        status: 'fail',
        detail: `missing ${missing.join(', ')}`,
        fix: 'copy .env.example to .env and fill them in',
      }
    : { id: 'env', label: 'Environment', status: 'pass', detail: `${required.join(', ')} set` };
}

function providerOf(config: CogitatorConfig | undefined): string | undefined {
  const model = config?.llm?.defaultModel;
  return model?.includes('/') ? model.split('/')[0] : config?.llm?.defaultProvider;
}

async function modelCheck(
  config: CogitatorConfig | undefined,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch | undefined
): Promise<DoctorCheck | undefined> {
  const provider = providerOf(config);
  const model = config?.llm?.defaultModel;
  if (!provider) return undefined;

  if (provider === 'ollama') {
    const baseUrl = resolveOllamaUrl(env, config?.llm?.providers?.ollama?.baseUrl);
    let models;
    try {
      models = await listOllamaModels(baseUrl, { apiKey: env.OLLAMA_API_KEY, timeoutMs: 3000 });
    } catch {
      return {
        id: 'model',
        label: 'Ollama',
        status: 'fail',
        detail: `not reachable at ${baseUrl}`,
        fix: 'start Ollama (ollama serve) or docker compose up -d ollama',
      };
    }
    const name = model?.slice('ollama/'.length);
    const tagged = (n: string) => (n.includes(':') ? n : `${n}:latest`);
    if (name && !models.some((m) => tagged(m.name) === tagged(name))) {
      return {
        id: 'model',
        label: 'Ollama',
        status: 'fail',
        detail: `${name} is not pulled`,
        fix: `ollama pull ${name}`,
      };
    }
    return {
      id: 'model',
      label: 'Ollama',
      status: 'pass',
      detail: `${baseUrl}, ${name ?? 'no default model'} ready`,
    };
  }

  if (provider === 'openai' || provider === 'anthropic' || provider === 'google') {
    const envKey = PROVIDER_INFO[provider].envKey ?? '';
    const key = env[envKey] ?? (provider === 'google' ? env.GEMINI_API_KEY : undefined);
    if (!key) {
      return {
        id: 'model',
        label: PROVIDER_INFO[provider].label,
        status: 'fail',
        detail: `${envKey} is not set`,
        fix: `set ${envKey} in .env`,
      };
    }
    const result = await checkApiKey(provider, key, { fetch: fetcher });
    const status: CheckStatus =
      result.status === 'valid' ? 'pass' : result.status === 'invalid' ? 'fail' : 'warn';
    return {
      id: 'model',
      label: PROVIDER_INFO[provider].label,
      status,
      detail: describeKeyCheck(envKey, result),
      ...(status === 'fail' && { fix: `create a new key at ${PROVIDER_INFO[provider].keyUrl}` }),
    };
  }
  return undefined;
}

/** Host and port of a service URL such as `redis://localhost:6379`, with the scheme's default port. */
export function endpointOf(
  url: string,
  defaultPort: number
): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.replace(/^\[|\]$/g, '') || 'localhost',
      port: Number(parsed.port) || defaultPort,
    };
  } catch {
    return undefined;
  }
}

/** Whether a TCP connection to `host:port` opens within `timeoutMs`. */
export function canConnect(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function memoryCheck(config: CogitatorConfig | undefined): Promise<DoctorCheck | undefined> {
  const memory = config?.memory;
  if (!memory?.adapter || memory.adapter === 'memory' || memory.adapter === 'sqlite')
    return undefined;
  const target =
    memory.adapter === 'redis'
      ? {
          url: memory.redis && 'url' in memory.redis ? memory.redis.url : undefined,
          port: 6379,
          service: 'redis',
        }
      : memory.adapter === 'postgres'
        ? { url: memory.postgres?.connectionString, port: 5432, service: 'postgres' }
        : memory.adapter === 'mongodb'
          ? { url: memory.mongodb?.uri, port: 27017, service: 'mongodb' }
          : undefined;
  if (!target) return undefined;
  const endpoint = target.url
    ? endpointOf(target.url, target.port)
    : { host: 'localhost', port: target.port };
  if (!endpoint) {
    return {
      id: 'memory',
      label: `Memory (${memory.adapter})`,
      status: 'fail',
      detail: 'the connection URL does not parse',
    };
  }
  const ok = await canConnect(endpoint.host, endpoint.port);
  return ok
    ? {
        id: 'memory',
        label: `Memory (${memory.adapter})`,
        status: 'pass',
        detail: `${endpoint.host}:${endpoint.port} answers`,
      }
    : {
        id: 'memory',
        label: `Memory (${memory.adapter})`,
        status: 'fail',
        detail: `nothing listens on ${endpoint.host}:${endpoint.port}`,
        fix: `docker compose up -d ${target.service}`,
      };
}

/** Everything `cogitator doctor` checks, in the order it shows them. */
export async function runDoctor(context: DoctorContext): Promise<DoctorCheck[]> {
  const manifest = readManifest(context.projectDir);
  const checks: DoctorCheck[] = [];
  if (!manifest) {
    return [
      {
        id: 'project',
        label: 'Project',
        status: 'fail',
        detail: `no package.json in ${context.projectDir}`,
        fix: 'run cogitator doctor in the project directory',
      },
    ];
  }
  checks.push(nodeCheck(manifest, context.nodeVersion));
  checks.push(packagesCheck(context.projectDir, manifest));
  const { check, config } = configCheck(context.projectDir);
  checks.push(check);
  checks.push(envCheck(context.projectDir, context.env));
  if (context.probe) {
    const model = await modelCheck(config, context.env, context.fetch);
    if (model) checks.push(model);
    const memory = await memoryCheck(config);
    if (memory) checks.push(memory);
  }
  return checks;
}
