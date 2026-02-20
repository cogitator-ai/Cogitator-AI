import type {
  DeployConfig,
  DeployServer,
  DeployServicesConfig,
  DeployTarget,
} from '@cogitator-ai/types';
import type { CogitatorConfigInput } from '@cogitator-ai/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_PACKAGES: Record<string, DeployServer> = {
  '@cogitator-ai/express': 'express',
  '@cogitator-ai/fastify': 'fastify',
  '@cogitator-ai/hono': 'hono',
  '@cogitator-ai/koa': 'koa',
};

const MODEL_SECRET_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  bedrock: 'AWS_ACCESS_KEY_ID',
  ollama: 'OLLAMA_API_KEY',
};

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface AnalyzerResult {
  server?: DeployServer;
  services: DeployServicesConfig;
  secrets: string[];
  warnings: string[];
  hasTypeScript: boolean;
  deployConfig: DeployConfig;
}

export class ProjectAnalyzer {
  detectServer(pkg: PackageJson): DeployServer | undefined {
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [pkgName, server] of Object.entries(SERVER_PACKAGES)) {
      if (pkgName in allDeps) return server;
    }
    return undefined;
  }

  detectServices(config: CogitatorConfigInput): DeployServicesConfig {
    const adapter = config.memory?.adapter;
    return {
      redis: adapter === 'redis',
      postgres: adapter === 'postgres',
    };
  }

  detectSecrets(model: string): string[] {
    const secrets: string[] = [];
    const provider = model.split('/')[0];

    if (provider && provider in MODEL_SECRET_MAP) {
      if (provider === 'ollama' && this.isOllamaCloud(model)) {
        secrets.push(MODEL_SECRET_MAP[provider]);
      } else if (provider !== 'ollama') {
        secrets.push(MODEL_SECRET_MAP[provider]);
      }
    }

    return secrets;
  }

  isOllamaCloud(model: string): boolean {
    const modelName = model.includes('/') ? model.split('/')[1] : model;
    return modelName?.includes(':cloud') ?? false;
  }

  getDeployWarnings(model: string, target: DeployTarget): string[] {
    const warnings: string[] = [];
    const provider = model.split('/')[0];

    if (provider === 'ollama' && !this.isOllamaCloud(model) && target !== 'docker') {
      warnings.push(
        `Model "${model}" requires local Ollama server. Cloud targets don't include Ollama. ` +
          'Use a cloud model (e.g. qwen3.5:cloud with OLLAMA_API_KEY), switch to a cloud LLM provider, ' +
          'or set OLLAMA_HOST to an external Ollama URL.'
      );
    }

    return warnings;
  }

  analyze(projectDir: string, configOverrides?: DeployConfig): AnalyzerResult {
    const pkgPath = join(projectDir, 'package.json');
    const pkg: PackageJson = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf-8')) : {};

    const server = configOverrides?.server ?? this.detectServer(pkg);
    const hasTypeScript = existsSync(join(projectDir, 'tsconfig.json'));

    return {
      server,
      services: configOverrides?.services ?? { redis: false, postgres: false },
      secrets: configOverrides?.secrets ?? [],
      warnings: [],
      hasTypeScript,
      deployConfig: {
        ...configOverrides,
        server,
        port: configOverrides?.port ?? 3000,
      },
    };
  }
}
