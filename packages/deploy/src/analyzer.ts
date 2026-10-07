import { parse as parseYaml } from 'yaml';
import type {
  CogitatorConfig,
  DeployConfig,
  DeployKind,
  DeployServer,
  DeployServicesConfig,
  DeployTarget,
  DeployVolume,
  LLMProvider,
  PreflightCheck,
} from '@cogitator-ai/types';
import { isLLMProvider, resolveModelRoute } from '@cogitator-ai/types';
import {
  findConfigFile,
  loadConfig,
  loadYamlConfig,
  OLLAMA_DEFAULT_PORT,
  PROVIDER_ENV,
  preferredEnvName,
  providerEnvNames,
  resolveOllamaHost,
  type CogitatorConfigInput,
  type ProviderEnvSetting,
} from '@cogitator-ai/config';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { resolveDeployEnv, sanitizeName } from './utils/env.js';
import type { PlugAndPlay } from './templates/dockerfile.js';
import { healthPath } from './templates/health.js';
import { APP_DIR } from './volumes.js';

const SERVER_PACKAGES: Record<string, DeployServer> = {
  '@cogitator-ai/express': 'express',
  '@cogitator-ai/fastify': 'fastify',
  '@cogitator-ai/hono': 'hono',
  '@cogitator-ai/koa': 'koa',
  '@cogitator-ai/tetsu': 'tetsu',
  '@cogitator-ai/next': 'next',
  next: 'next',
};

/** HTTP frameworks a project may serve with directly, without a Cogitator adapter. */
const HTTP_PACKAGES = ['express', 'fastify', 'hono', '@hono/node-server', 'koa'];

/** Packages of long-running processes that serve no HTTP: channel gateways, queue workers. */
const WORKER_PACKAGES = ['@cogitator-ai/channels', '@cogitator-ai/worker'];

/** Runtimes that need Bun, whatever the lockfile says. */
const BUN_PACKAGES = ['@cogitator-ai/tetsu'];

const DOCKER_HOST_GATEWAY = 'host.docker.internal';
const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '[::1]', '[::]', '::1']);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', '.cogitator']);
const MAX_SCANNED_FILES = 2000;
const REQUIRE_ENV_CALL = /\brequireEnv\(\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\)/g;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const ENV_FILE_FLAG = /--env-file(?!-if-exists)(?:=|\s+)(\S+)/;

/**
 * The package manager a project installs with. `yarn` is Yarn 1 (classic),
 * `yarn-berry` is Yarn 2 and later, which take different install flags.
 */
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'yarn-berry' | 'bun';

interface PackageJson {
  name?: string;
  type?: string;
  main?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
  patchedDependencies?: Record<string, string>;
}

/** How a project builds and starts: what the generated Dockerfile needs. */
export interface ProjectBuild {
  hasTypeScript: boolean;
  packageManager: PackageManager;
  hasLockfile: boolean;
  hasBuildScript: boolean;
  startCommand: string[];
  /** Project files the install step reads, copied before it runs, directories with a trailing slash */
  installFiles: string[];
  /** Version of the package manager from the `packageManager` field, e.g. `4.5.0` */
  packageManagerVersion?: string;
  /** Set when Yarn installs with Plug'n'Play: no node_modules, a resolver the app has to load. */
  plugAndPlay?: PlugAndPlay;
}

export interface AnalyzerResult extends ProjectBuild {
  server?: DeployServer;
  kind?: DeployKind;
  services: DeployServicesConfig;
  secrets: string[];
  warnings: string[];
  /** Project checks every target's preflight includes */
  checks: PreflightCheck[];
  deployConfig: DeployConfig;
}

export interface AnalyzeOptions {
  /** Config file to read, `findConfigFile(projectDir)` by default */
  configPath?: string;
  /** Environment the deployment takes its secrets from, the project's `.env` under the process environment by default */
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== '';
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function mergeSection<T extends object>(
  file: T | undefined,
  override: T | undefined
): T | undefined {
  return file && override ? { ...file, ...override } : (override ?? file);
}

/**
 * The deploy config the project asks for: the `deploy` section of its
 * cogitator.yml under explicit overrides, merging the nested sections
 * (services, env, health, resources) field by field.
 */
function mergeDeployConfig(
  file: DeployConfig | undefined,
  overrides: Partial<DeployConfig> | undefined
): Partial<DeployConfig> {
  return {
    ...file,
    ...overrides,
    services: mergeSection(file?.services, overrides?.services),
    env: mergeSection(file?.env, overrides?.env),
    health: mergeSection(file?.health, overrides?.health),
    resources: mergeSection(file?.resources, overrides?.resources),
  };
}

function readPackageJson(projectDir: string, warnings: string[]): PackageJson {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch (error) {
    warnings.push(
      `Could not parse package.json: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
  if (!isRecord(raw)) return {};

  const pnpm = raw.pnpm;
  const patched = {
    ...(isRecord(pnpm) && isStringRecord(pnpm.patchedDependencies) ? pnpm.patchedDependencies : {}),
    ...(isStringRecord(raw.patchedDependencies) ? raw.patchedDependencies : {}),
  };

  return {
    name: typeof raw.name === 'string' ? raw.name : undefined,
    type: typeof raw.type === 'string' ? raw.type : undefined,
    main: typeof raw.main === 'string' ? raw.main : undefined,
    packageManager: typeof raw.packageManager === 'string' ? raw.packageManager : undefined,
    scripts: isStringRecord(raw.scripts) ? raw.scripts : undefined,
    dependencies: isStringRecord(raw.dependencies) ? raw.dependencies : undefined,
    devDependencies: isStringRecord(raw.devDependencies) ? raw.devDependencies : undefined,
    patchedDependencies: Object.keys(patched).length > 0 ? patched : undefined,
  };
}

function hasDependency(pkg: PackageJson, names: readonly string[]): boolean {
  return names.some(
    (name) => name in (pkg.dependencies ?? {}) || name in (pkg.devDependencies ?? {})
  );
}

/** `name@version` of the `packageManager` field, e.g. `yarn@4.5.0+sha512...`. */
function parsePackageManagerField(
  field: string | undefined
): { name: string; version?: string } | undefined {
  const match = /^([a-z]+)(?:@([^+\s]+))?/.exec(field?.trim() ?? '');
  return match ? { name: match[1], version: match[2] } : undefined;
}

function majorVersion(version: string | undefined): number | undefined {
  const major = version ? Number.parseInt(version, 10) : Number.NaN;
  return Number.isNaN(major) ? undefined : major;
}

/** Variable names in a `.env`-style file, comments and blank lines skipped. */
function envFileKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((line) => ENV_LINE.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

/** Names passed as string literals to `requireEnv(...)` in the project's sources. */
function requiredEnvNames(projectDir: string): string[] {
  const names: string[] = [];
  let scanned = 0;
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (scanned >= MAX_SCANNED_FILES) return;
      if (SKIPPED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        visit(full);
      } else if (SOURCE_EXTENSIONS.test(entry)) {
        scanned++;
        for (const match of readFileSync(full, 'utf-8').matchAll(REQUIRE_ENV_CALL)) {
          names.push(match[2]);
        }
      }
    }
  };
  visit(join(projectDir, 'src'));
  return unique(names);
}

/** The host of `url`, or undefined when it does not parse. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isLoopbackUrl(url: string): boolean {
  const host = hostOf(url);
  return host === undefined || LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

function portOf(url: string): number {
  try {
    const port = new URL(url).port;
    return port ? Number.parseInt(port, 10) : OLLAMA_DEFAULT_PORT;
  } catch {
    return OLLAMA_DEFAULT_PORT;
  }
}

function providerField(
  providers: Record<string, unknown> | undefined,
  provider: LLMProvider,
  field: string
): string | undefined {
  const section = providers?.[provider];
  if (!isRecord(section)) return undefined;
  const value = section[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The first directory of a relative path inside the project, undefined for anything else. */
function topDirectory(path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const first = posix.normalize(path.replace(/\\/g, '/')).split('/')[0];
  return first && first !== '..' && first !== '.' ? first : undefined;
}

const LOCAL_SPEC = /^(?:file|link):(.+)$/;

/**
 * Relative paths of the local packages the install reads (`file:` and `link:`
 * specs in dependencies, overrides and resolutions, and in the overrides of
 * pnpm-workspace.yaml), so the image copies them before it installs.
 */
export function localDependencySpecs(projectDir: string, pkg: PackageJson): string[] {
  const specs: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') {
      const match = LOCAL_SPEC.exec(value.trim());
      if (match) specs.push(match[1]);
    } else if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value)) collect(nested);
    }
  };
  for (const field of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.optionalDependencies,
    pkg.overrides,
    pkg.resolutions,
  ]) {
    collect(field);
  }
  const workspace = join(projectDir, 'pnpm-workspace.yaml');
  if (existsSync(workspace)) {
    try {
      const parsed: unknown = parseYaml(readFileSync(workspace, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null && 'overrides' in parsed)
        collect(parsed.overrides);
    } catch {
      return specs;
    }
  }
  return specs;
}

/** `.env` never reaches the image (.dockerignore), so a flag that loads it only logs that it is missing. */
const DOTENV_FLAG = /^--env-file(?:-if-exists)?(?:=|$)/;

const PLAIN_WORD = /^[^\s&|;<>$`"'*?()]+$/;

/**
 * `start` as argv when it is `node` or `bun` with flags and one script, such as
 * `node --env-file-if-exists=.env dist/index.js`, and undefined for anything a
 * shell would have to interpret. Flags that load `.env` are dropped: the image
 * gets its environment from the deployment.
 */
export function directCommand(start: string): string[] | undefined {
  const words = start.split(/\s+/);
  const [runtime, ...rest] = words;
  if (runtime !== 'node' && runtime !== 'bun') return undefined;
  if (rest.length === 0 || !rest.every((word) => PLAIN_WORD.test(word))) return undefined;
  const script = rest[rest.length - 1];
  if (script.startsWith('-') || rest.slice(0, -1).some((word) => !word.startsWith('--')))
    return undefined;
  return [runtime, ...rest.filter((word) => !DOTENV_FLAG.test(word))];
}

export class ProjectAnalyzer {
  detectServer(pkg: PackageJson): DeployServer | undefined {
    for (const [pkgName, server] of Object.entries(SERVER_PACKAGES)) {
      if (hasDependency(pkg, [pkgName])) return server;
    }
    return undefined;
  }

  /**
   * What the project runs as: a `server` when it serves HTTP through a Cogitator
   * adapter or an HTTP framework, a `worker` when it runs a channel gateway or
   * queue worker, undefined for anything else, such as a script that exits.
   */
  detectKind(pkg: PackageJson, server: DeployServer | undefined): DeployKind | undefined {
    if (server || hasDependency(pkg, HTTP_PACKAGES)) return 'server';
    if (hasDependency(pkg, WORKER_PACKAGES)) return 'worker';
    return undefined;
  }

  detectServices(config: { memory?: { adapter?: string | null } }): DeployServicesConfig {
    const adapter = config.memory?.adapter;
    return {
      redis: adapter === 'redis',
      postgres: adapter === 'postgres',
    };
  }

  /**
   * Variables the provider of `model` cannot run without, routed the way the
   * runtime routes it. Each is the variable set in `env` among the ones that
   * provide the setting, else the provider's own name for it. Settings with a
   * value written in `providers` (cogitator.yml) need none.
   */
  detectSecrets(
    model: string,
    defaultProvider?: string,
    env: NodeJS.ProcessEnv = {},
    providers?: Record<string, unknown>
  ): string[] {
    const provider = this.providerOf(model, defaultProvider);
    if (!provider) return [];
    const required = PROVIDER_ENV[provider].filter(
      (setting) =>
        setting.required ||
        (provider === 'ollama' && setting.field === 'apiKey' && this.isOllamaCloud(model))
    );
    return required
      .filter((setting) => !providerField(providers, provider, setting.field))
      .map((setting) => this.envNameFor(setting, env));
  }

  isOllamaCloud(model: string): boolean {
    const modelName = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    return /(?::|-)cloud$/.test(modelName);
  }

  getDeployWarnings(model: string, target: DeployTarget, defaultProvider?: string): string[] {
    const warnings: string[] = [];
    if (
      this.providerOf(model, defaultProvider) === 'ollama' &&
      !this.isOllamaCloud(model) &&
      target !== 'docker'
    ) {
      warnings.push(
        `Model "${model}" requires local Ollama server. Cloud targets don't include Ollama. ` +
          'Use a cloud model (e.g. qwen3.5:cloud with OLLAMA_API_KEY), switch to a cloud LLM provider, ' +
          'or set OLLAMA_HOST to an external Ollama URL.'
      );
    }
    return warnings;
  }

  detectPackageManager(
    projectDir: string,
    pkg: PackageJson = readPackageJson(projectDir, [])
  ): { packageManager: PackageManager; hasLockfile: boolean } {
    const declared = parsePackageManagerField(pkg.packageManager);
    const berry =
      existsSync(join(projectDir, '.yarnrc.yml')) ||
      (declared?.name === 'yarn' && (majorVersion(declared.version) ?? 1) >= 2);
    const has = (file: string) => existsSync(join(projectDir, file));

    if (has('pnpm-lock.yaml')) return { packageManager: 'pnpm', hasLockfile: true };
    if (has('bun.lock') || has('bun.lockb')) return { packageManager: 'bun', hasLockfile: true };
    if (has('yarn.lock')) {
      const lock = readFileSync(join(projectDir, 'yarn.lock'), 'utf-8');
      const isBerry = berry || /^__metadata:/m.test(lock);
      return { packageManager: isBerry ? 'yarn-berry' : 'yarn', hasLockfile: true };
    }
    if (has('package-lock.json') || has('npm-shrinkwrap.json')) {
      return { packageManager: 'npm', hasLockfile: true };
    }

    switch (declared?.name) {
      case 'pnpm':
      case 'bun':
        return { packageManager: declared.name, hasLockfile: false };
      case 'yarn':
        return { packageManager: berry ? 'yarn-berry' : 'yarn', hasLockfile: false };
    }
    if (has('pnpm-workspace.yaml')) return { packageManager: 'pnpm', hasLockfile: false };
    const start = pkg.scripts?.start?.trim() ?? '';
    if (hasDependency(pkg, BUN_PACKAGES) || /^bun(?:x)?\s/.test(start)) {
      return { packageManager: 'bun', hasLockfile: false };
    }
    return { packageManager: 'npm', hasLockfile: false };
  }

  /**
   * The command a container runs: the start script itself when it is a plain
   * `node` or `bun` call, so the runtime is PID 1's direct child and gets
   * signals without a package manager in between, else the package manager.
   */
  detectStartCommand(
    pkg: PackageJson,
    hasTypeScript: boolean,
    packageManager: PackageManager = 'npm'
  ): string[] {
    const bun = packageManager === 'bun';
    const start = pkg.scripts?.start?.trim();
    if (start) {
      const direct = directCommand(start);
      if (direct) return direct;
      if (bun) return ['bun', 'run', 'start'];
      if (packageManager === 'yarn-berry') return ['yarn', 'start'];
      return ['npm', 'start'];
    }
    const runtime = bun ? 'bun' : 'node';
    if (pkg.main) return [runtime, pkg.main];
    return [runtime, hasTypeScript ? 'dist/server.js' : 'src/server.js'];
  }

  /** How the project in `projectDir` builds and starts. */
  detectBuild(projectDir: string): ProjectBuild {
    return this.buildOf(projectDir, readPackageJson(projectDir, []));
  }

  /**
   * Reads the project in `projectDir` into a deploy config: what it detects,
   * under the `deploy` section of the project's config file, under
   * `configOverrides`.
   */
  analyze(
    projectDir: string,
    configOverrides?: Partial<DeployConfig>,
    options: AnalyzeOptions = {}
  ): AnalyzerResult {
    const warnings: string[] = [];
    const checks: PreflightCheck[] = [];
    const env = options.env ?? resolveDeployEnv(projectDir);
    const hasPackageJson = existsSync(join(projectDir, 'package.json'));
    const pkg = readPackageJson(projectDir, warnings);
    const configPath = options.configPath ?? findConfigFile(projectDir);
    const fullConfig = this.loadProjectConfig(configPath, warnings);
    const configured = mergeDeployConfig(fullConfig?.deploy, configOverrides);

    const server = configured.server ?? this.detectServer(pkg);
    const kind =
      configured.kind ?? (configured.health?.path ? 'server' : this.detectKind(pkg, server));
    const target = configured.target ?? 'docker';
    const build = this.buildOf(projectDir, pkg);

    checks.push(this.packageJsonCheck(projectDir, hasPackageJson));
    checks.push(this.kindCheck(kind));
    const envFileCheck = this.startScriptCheck(pkg);
    if (envFileCheck) checks.push(envFileCheck);

    if (hasPackageJson && !pkg.scripts?.start && !pkg.main) {
      warnings.push(
        `No "start" script or "main" in package.json, the container will run "${build.startCommand.join(' ')}"`
      );
    }
    if (build.hasTypeScript && !build.hasBuildScript) {
      warnings.push(
        'tsconfig.json found but package.json has no "build" script, skipping build step'
      );
    }
    if (this.isPnpmMonorepo(projectDir)) {
      warnings.push(
        'pnpm-workspace.yaml lists workspace packages: only this directory goes into the image, so deploy a single package'
      );
    }

    const model = fullConfig?.llm?.defaultModel ?? '';
    const defaultProvider = fullConfig?.llm?.defaultProvider;
    const rawProviders = this.literalProviders(configPath);

    const services =
      configured.services ??
      (fullConfig ? this.detectServices(fullConfig) : { redis: false, postgres: false });

    const appSecrets =
      configured.secrets ??
      unique([
        ...(model || defaultProvider
          ? this.detectSecrets(model, defaultProvider, env, rawProviders)
          : []),
        ...this.optionalProviderSecrets(model, defaultProvider, env),
        ...requiredEnvNames(projectDir),
        ...envFileKeys(join(projectDir, '.env.example')).filter((key) => isSet(env, key)),
      ]);

    const ollama = this.ollamaWiring(model, defaultProvider, target, env, configPath, warnings);
    const infraSecrets = [
      ...ollama.secrets,
      ...(target === 'fly' ? this.flyServiceSecrets(services, warnings) : []),
    ];
    const secrets = unique([...appSecrets, ...infraSecrets]);

    if (configured.secrets === undefined && secrets.length === 0) {
      const local = envFileKeys(join(projectDir, '.env'));
      if (local.length > 0) {
        checks.push({
          name: 'Secrets',
          passed: false,
          message: `No secrets detected, but .env defines ${local.join(', ')}: the deployment would start without them`,
          fix: 'List the variables the app needs in deploy.secrets in cogitator.yml (an empty list deploys without any)',
        });
      }
    }
    if (secrets.some((name) => name.endsWith('SESSION_TOKEN') && /AWS|BEDROCK/.test(name))) {
      warnings.push(
        'AWS_SESSION_TOKEN is set: temporary credentials expire, and the deployed app stops reaching Bedrock when they do. Deploy with long-lived credentials or a role of the host.'
      );
    }

    if (model) warnings.push(...this.getDeployWarnings(model, target, defaultProvider));

    if (target === 'docker' && (configured.instances ?? 1) > 1) {
      warnings.push('instances > 1 is not supported for the docker target, running one container');
    }

    const volumes = configured.volumes ?? this.detectVolumes(fullConfig, warnings);
    if (volumes && target === 'fly') {
      if (volumes.length > 1) {
        checks.push({
          name: 'Volumes',
          passed: false,
          message: `Fly machines mount one volume, ${volumes.length} are configured`,
          fix: 'Keep the data the app writes under one directory and list only it in deploy.volumes',
        });
      }
      if ((configured.instances ?? 1) > 1) {
        warnings.push(
          'Each Fly machine gets its own volume: with instances > 1 the machines do not share the data on it'
        );
      }
    }

    const port = kind === 'worker' ? configured.port : (configured.port ?? 3000);
    const image = configured.image ?? sanitizeName(pkg.name ?? '');
    const deployConfig: DeployConfig = {
      ...configured,
      server,
      kind,
      image,
      services,
      secrets,
      port,
      ...(volumes && volumes.length > 0 ? { volumes } : {}),
      ...(ollama.env ? { env: { ...ollama.env, ...configured.env }, hostGateway: true } : {}),
    };
    if (deployConfig.env === undefined) delete deployConfig.env;
    if (deployConfig.volumes === undefined) delete deployConfig.volumes;

    if (kind === 'server' && !healthPath(deployConfig)) {
      warnings.push(
        'No health check: set deploy.health.path to the route that answers health checks, the platform probes it to tell the app is up'
      );
    }

    return {
      server,
      kind,
      services,
      secrets,
      warnings,
      checks,
      ...build,
      deployConfig,
    };
  }

  private providerOf(model: string, defaultProvider?: string): LLMProvider | undefined {
    const { provider } = model
      ? resolveModelRoute(model, { defaultProvider })
      : { provider: defaultProvider ?? '' };
    return isLLMProvider(provider) ? provider : undefined;
  }

  private envNameFor(setting: ProviderEnvSetting, env: NodeJS.ProcessEnv): string {
    return providerEnvNames(setting).find((name) => isSet(env, name)) ?? preferredEnvName(setting);
  }

  /** Optional settings of the model's provider set in `env`, forwarded so the app sees them too. */
  private optionalProviderSecrets(
    model: string,
    defaultProvider: string | undefined,
    env: NodeJS.ProcessEnv
  ): string[] {
    const provider = this.providerOf(model, defaultProvider);
    if (!provider) return [];
    return PROVIDER_ENV[provider]
      .filter((setting) => !setting.required && !setting.local)
      .map((setting) => providerEnvNames(setting).find((name) => isSet(env, name)))
      .filter((name): name is string => name !== undefined);
  }

  /**
   * How a local Ollama is reached from the deployment. A URL that already
   * points beyond this machine is forwarded. Otherwise the docker target
   * reaches the host through `host.docker.internal`, and other targets warn.
   */
  private ollamaWiring(
    model: string,
    defaultProvider: string | undefined,
    target: DeployTarget,
    env: NodeJS.ProcessEnv,
    configPath: string | undefined,
    warnings: string[]
  ): { secrets: string[]; env?: Record<string, string> } {
    if (this.providerOf(model, defaultProvider) !== 'ollama' || this.isOllamaCloud(model)) {
      return { secrets: [] };
    }
    const setting = PROVIDER_ENV.ollama.find((s) => s.field === 'baseUrl');
    const overrideNames = setting?.env ?? [];
    const fallbackNames = setting?.fallbackEnv ?? [];
    const firstUrl = (names: readonly string[]) =>
      names.map((name) => resolveOllamaHost(env[name])).find((url) => url !== undefined);

    const configured = this.yamlInput(configPath, env)?.llm?.providers?.ollama?.baseUrl;
    const url = firstUrl(overrideNames) ?? resolveOllamaHost(configured) ?? firstUrl(fallbackNames);

    if (url && !isLoopbackUrl(url)) {
      const forwarded = [...overrideNames, ...fallbackNames].filter((name) => {
        const value = resolveOllamaHost(env[name]);
        return value !== undefined && !isLoopbackUrl(value);
      });
      return { secrets: forwarded };
    }

    if (target !== 'docker') return { secrets: [] };

    const hostUrl = `http://${DOCKER_HOST_GATEWAY}:${url ? portOf(url) : OLLAMA_DEFAULT_PORT}`;
    warnings.push(
      `Model "${model}" runs on the Ollama of this machine: the container reaches it at ${hostUrl}. ` +
        'On Linux, Ollama must listen beyond localhost (OLLAMA_HOST=0.0.0.0 ollama serve), ' +
        `and the model must be pulled (ollama pull ${model.replace(/^ollama\//, '')}).`
    );
    return {
      secrets: [],
      env: Object.fromEntries([...overrideNames, ...fallbackNames].map((name) => [name, hostUrl])),
    };
  }

  private flyServiceSecrets(services: DeployServicesConfig, warnings: string[]): string[] {
    const secrets: string[] = [];
    if (services.redis) {
      secrets.push('REDIS_URL');
      warnings.push(
        'Fly runs no Redis next to the app: create one (fly redis create, or any Redis such as Upstash) and set REDIS_URL'
      );
    }
    if (services.postgres) {
      secrets.push('DATABASE_URL');
      warnings.push(
        'Fly runs no Postgres next to the app: create one (fly postgres create, or any Postgres) and set DATABASE_URL'
      );
    }
    return secrets;
  }

  private detectVolumes(
    config: CogitatorConfig | undefined,
    warnings: string[]
  ): DeployVolume[] | undefined {
    if (config?.memory?.adapter !== 'sqlite') return undefined;
    const dbPath = config.memory.sqlite?.path;
    if (!dbPath) {
      warnings.push(
        'SQLite memory without memory.sqlite.path: set it to a file in a directory (data/memory.db) so the database can live on a volume'
      );
      return undefined;
    }
    if (dbPath === ':memory:') return undefined;

    const dir = posix.dirname(posix.normalize(dbPath.replace(/\\/g, '/')));
    if (dir === '.' || dir === '/') {
      warnings.push(
        `The SQLite database ${dbPath} sits in the ${dir === '/' ? 'root' : 'app'} directory, so it cannot get a volume and is lost on every deploy. Move it into a directory, such as data/memory.db`
      );
      return undefined;
    }
    const path = dir.startsWith('..') ? posix.join(APP_DIR, dir) : dir.replace(/^\.\//, '');
    return [{ path }];
  }

  private packageJsonCheck(projectDir: string, exists: boolean): PreflightCheck {
    return exists
      ? { name: 'package.json', passed: true, message: 'package.json found' }
      : {
          name: 'package.json',
          passed: false,
          message: `No package.json in ${projectDir}`,
          fix: 'Deploy a Node.js project (cogitator init, create-cogitator-app). An assistant made by cogitator wizard runs with cogitator up or cogitator daemon start',
        };
  }

  private kindCheck(kind: DeployKind | undefined): PreflightCheck {
    return kind
      ? { name: 'Project kind', passed: true, message: `Deploys as a ${kind}` }
      : {
          name: 'Project kind',
          passed: false,
          message:
            'No HTTP server or long-running worker found: a script that exits after one run would be restarted forever',
          fix: 'Set deploy.kind in cogitator.yml: server (answers HTTP on deploy.port) or worker (runs without HTTP, like a bot). Run a one-off script with node or tsx instead',
        };
  }

  private startScriptCheck(pkg: PackageJson): PreflightCheck | undefined {
    const match = ENV_FILE_FLAG.exec(pkg.scripts?.start ?? '');
    if (!match) return undefined;
    return {
      name: 'Start script environment',
      passed: false,
      message: `The "start" script loads ${match[1]} with --env-file, but .env files stay out of the image, so the container would exit at start`,
      fix: `Use --env-file-if-exists=${match[1]} (Node 22.9+, tsx), the deployment passes the variables through the environment`,
    };
  }

  private isPnpmMonorepo(projectDir: string): boolean {
    const path = join(projectDir, 'pnpm-workspace.yaml');
    return existsSync(path) && /^packages\s*:/m.test(readFileSync(path, 'utf-8'));
  }

  private loadProjectConfig(
    configPath: string | undefined,
    warnings: string[]
  ): CogitatorConfig | undefined {
    if (!configPath) return undefined;
    try {
      return loadConfig({ configPath, skipEnv: true });
    } catch (error) {
      warnings.push(
        `Ignoring invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  private yamlInput(
    configPath: string | undefined,
    env: NodeJS.ProcessEnv
  ): CogitatorConfigInput | undefined {
    if (!configPath || !existsSync(configPath)) return undefined;
    try {
      return loadYamlConfig(configPath, env) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** `llm.providers` of the config file with every `${VAR}` reference left empty: the values written in it. */
  private literalProviders(configPath: string | undefined): Record<string, unknown> | undefined {
    const providers: unknown = this.yamlInput(configPath, {})?.llm?.providers;
    return isRecord(providers) ? providers : undefined;
  }

  private installFiles(projectDir: string, pkg: PackageJson, pm: PackageManager): string[] {
    const candidates: Record<PackageManager, readonly string[]> = {
      pnpm: ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs'],
      npm: ['package-lock.json', 'npm-shrinkwrap.json'],
      yarn: ['yarn.lock', '.yarnrc'],
      'yarn-berry': ['yarn.lock', '.yarnrc.yml', '.yarn'],
      bun: ['bun.lock', 'bun.lockb', 'bunfig.toml'],
    };
    const isDir = (dir: string | undefined): dir is string => dir !== undefined;
    const patchDirs = Object.values(pkg.patchedDependencies ?? {})
      .map(topDirectory)
      .filter(isDir);
    const localDirs = localDependencySpecs(projectDir, pkg).map(topDirectory).filter(isDir);

    return unique([...candidates[pm], '.npmrc', 'patches', ...patchDirs, ...localDirs])
      .filter((file) => existsSync(join(projectDir, file)))
      .map((file) => (statSync(join(projectDir, file)).isDirectory() ? `${file}/` : file));
  }

  /**
   * Plug'n'Play settings of a Yarn 2+ project, `undefined` when it installs
   * node_modules. PnP is Yarn's default linker, and Yarn writes the ESM loader
   * when it is asked to or when a workspace is an ES module.
   */
  detectPlugAndPlay(projectDir: string, pkg: PackageJson): PlugAndPlay | undefined {
    const rcPath = join(projectDir, '.yarnrc.yml');
    let rc: Record<string, unknown> = {};
    if (existsSync(rcPath)) {
      try {
        const parsed: unknown = parseYaml(readFileSync(rcPath, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          rc = parsed as Record<string, unknown>;
      } catch {
        rc = {};
      }
    }
    const linker = typeof rc.nodeLinker === 'string' ? rc.nodeLinker : 'pnp';
    if (linker !== 'pnp') return undefined;
    return {
      esmLoader:
        rc.pnpEnableEsmLoader === true ||
        pkg.type === 'module' ||
        existsSync(join(projectDir, '.pnp.loader.mjs')),
    };
  }

  private buildOf(projectDir: string, pkg: PackageJson): ProjectBuild {
    const hasTypeScript = existsSync(join(projectDir, 'tsconfig.json'));
    const pm = this.detectPackageManager(projectDir, pkg);
    const declared = parsePackageManagerField(pkg.packageManager);
    const binary = pm.packageManager === 'yarn-berry' ? 'yarn' : pm.packageManager;
    const version = declared?.name === binary ? declared.version : undefined;
    const plugAndPlay =
      pm.packageManager === 'yarn-berry' ? this.detectPlugAndPlay(projectDir, pkg) : undefined;
    return {
      hasTypeScript,
      ...pm,
      hasBuildScript: typeof pkg.scripts?.build === 'string',
      startCommand: this.detectStartCommand(pkg, hasTypeScript, pm.packageManager),
      installFiles: this.installFiles(projectDir, pkg, pm.packageManager),
      ...(version ? { packageManagerVersion: version } : {}),
      ...(plugAndPlay && { plugAndPlay }),
    };
  }
}
