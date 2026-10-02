import type {
  CogitatorConfig,
  DeployConfig,
  DeployServer,
  DeployServicesConfig,
  DeployTarget,
} from '@cogitator-ai/types';
import { loadConfig } from '@cogitator-ai/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeName } from './utils/env.js';

const SERVER_PACKAGES: Record<string, DeployServer> = {
  '@cogitator-ai/express': 'express',
  '@cogitator-ai/fastify': 'fastify',
  '@cogitator-ai/hono': 'hono',
  '@cogitator-ai/koa': 'koa',
};

const PROVIDER_SECRETS: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  bedrock: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  ollama: ['OLLAMA_API_KEY'],
};

const CONFIG_FILES = ['cogitator.yml', 'cogitator.yaml'];

export type PackageManager = 'pnpm' | 'npm' | 'yarn';

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface AnalyzerResult {
  server?: DeployServer;
  services: DeployServicesConfig;
  secrets: string[];
  warnings: string[];
  hasTypeScript: boolean;
  packageManager: PackageManager;
  hasLockfile: boolean;
  hasBuildScript: boolean;
  startCommand: string[];
  deployConfig: DeployConfig;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
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
  if (typeof raw !== 'object' || raw === null) return {};

  const get = (key: string): unknown => Reflect.get(raw, key);
  const name = get('name');
  const main = get('main');
  const scripts = get('scripts');
  const dependencies = get('dependencies');
  const devDependencies = get('devDependencies');

  return {
    name: typeof name === 'string' ? name : undefined,
    main: typeof main === 'string' ? main : undefined,
    scripts: isStringRecord(scripts) ? scripts : undefined,
    dependencies: isStringRecord(dependencies) ? dependencies : undefined,
    devDependencies: isStringRecord(devDependencies) ? devDependencies : undefined,
  };
}

export class ProjectAnalyzer {
  detectServer(pkg: PackageJson): DeployServer | undefined {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [pkgName, server] of Object.entries(SERVER_PACKAGES)) {
      if (pkgName in allDeps) return server;
    }
    return undefined;
  }

  detectServices(config: { memory?: { adapter?: string | null } }): DeployServicesConfig {
    const adapter = config.memory?.adapter;
    return {
      redis: adapter === 'redis',
      postgres: adapter === 'postgres',
    };
  }

  detectSecrets(model: string, defaultProvider?: string): string[] {
    const provider = model.includes('/') ? model.split('/')[0] : defaultProvider;
    if (!provider || !(provider in PROVIDER_SECRETS)) return [];
    if (provider === 'ollama' && !this.isOllamaCloud(model)) return [];
    return [...PROVIDER_SECRETS[provider]];
  }

  isOllamaCloud(model: string): boolean {
    const modelName = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    return /(?::|-)cloud$/.test(modelName);
  }

  getDeployWarnings(model: string, target: DeployTarget, defaultProvider?: string): string[] {
    const warnings: string[] = [];
    const provider = model.includes('/') ? model.split('/')[0] : defaultProvider;

    if (provider === 'ollama' && !this.isOllamaCloud(model) && target !== 'docker') {
      warnings.push(
        `Model "${model}" requires local Ollama server. Cloud targets don't include Ollama. ` +
          'Use a cloud model (e.g. qwen3.5:cloud with OLLAMA_API_KEY), switch to a cloud LLM provider, ' +
          'or set OLLAMA_HOST to an external Ollama URL.'
      );
    }

    return warnings;
  }

  detectPackageManager(projectDir: string): {
    packageManager: PackageManager;
    hasLockfile: boolean;
  } {
    if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
      return { packageManager: 'pnpm', hasLockfile: true };
    }
    if (existsSync(join(projectDir, 'yarn.lock'))) {
      return { packageManager: 'yarn', hasLockfile: true };
    }
    if (existsSync(join(projectDir, 'package-lock.json'))) {
      return { packageManager: 'npm', hasLockfile: true };
    }
    return { packageManager: 'npm', hasLockfile: false };
  }

  detectStartCommand(pkg: PackageJson, hasTypeScript: boolean): string[] {
    const start = pkg.scripts?.start?.trim();
    if (start) {
      const nodeScript = /^node\s+([^\s&|;<>$`"']+)$/.exec(start);
      return nodeScript ? ['node', nodeScript[1]] : ['npm', 'start'];
    }
    if (pkg.main) return ['node', pkg.main];
    return ['node', hasTypeScript ? 'dist/server.js' : 'src/server.js'];
  }

  private loadProjectConfig(projectDir: string, warnings: string[]): CogitatorConfig | undefined {
    const configPath = CONFIG_FILES.map((name) => join(projectDir, name)).find((p) =>
      existsSync(p)
    );
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

  analyze(projectDir: string, configOverrides?: Partial<DeployConfig>): AnalyzerResult {
    const warnings: string[] = [];
    const pkg = readPackageJson(projectDir, warnings);

    const server = configOverrides?.server ?? this.detectServer(pkg);
    const hasTypeScript = existsSync(join(projectDir, 'tsconfig.json'));
    const target = configOverrides?.target ?? 'docker';
    const { packageManager, hasLockfile } = this.detectPackageManager(projectDir);
    const startCommand = this.detectStartCommand(pkg, hasTypeScript);
    const hasBuildScript = typeof pkg.scripts?.build === 'string';

    if (!pkg.scripts?.start && !pkg.main) {
      warnings.push(
        `No "start" script or "main" in package.json — the container will run "${startCommand.join(' ')}"`
      );
    }
    if (hasTypeScript && !hasBuildScript) {
      warnings.push(
        'tsconfig.json found but package.json has no "build" script — skipping build step'
      );
    }

    const fullConfig = this.loadProjectConfig(projectDir, warnings);
    const model = fullConfig?.llm?.defaultModel ?? '';
    const defaultProvider = fullConfig?.llm?.defaultProvider;

    const services =
      configOverrides?.services ??
      (fullConfig ? this.detectServices(fullConfig) : { redis: false, postgres: false });
    const secrets =
      configOverrides?.secrets ?? (model ? this.detectSecrets(model, defaultProvider) : []);
    if (model) warnings.push(...this.getDeployWarnings(model, target, defaultProvider));

    if (target === 'docker' && (configOverrides?.instances ?? 1) > 1) {
      warnings.push('instances > 1 is not supported for the docker target; running one container');
    }

    const image = configOverrides?.image ?? sanitizeName(pkg.name ?? '');

    return {
      server,
      services,
      secrets,
      warnings,
      hasTypeScript,
      packageManager,
      hasLockfile,
      hasBuildScript,
      startCommand,
      deployConfig: {
        ...configOverrides,
        server,
        image,
        services,
        secrets,
        port: configOverrides?.port ?? 3000,
      },
    };
  }
}
