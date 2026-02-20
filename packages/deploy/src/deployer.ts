import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  DeployTarget,
  PreflightResult,
} from '@cogitator-ai/types';
import type { DeployProvider } from './providers/base.js';
import { DockerProvider } from './providers/docker.js';
import { FlyProvider } from './providers/fly.js';
import { ProjectAnalyzer } from './analyzer.js';
import { ArtifactGenerator } from './generator.js';

export interface DeployOptions {
  projectDir: string;
  target: DeployTarget;
  dryRun?: boolean;
  noPush?: boolean;
  configOverrides?: Partial<DeployConfig>;
}

export interface DeployPlan {
  config: DeployConfig;
  preflight: PreflightResult;
  provider: DeployProvider;
}

export class Deployer {
  private providers = new Map<string, DeployProvider>();
  private analyzer = new ProjectAnalyzer();
  private generator = new ArtifactGenerator();

  constructor() {
    this.registerProvider(new DockerProvider());
    this.registerProvider(new FlyProvider());
  }

  registerProvider(provider: DeployProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(target: DeployTarget): DeployProvider {
    const provider = this.providers.get(target);
    if (!provider) {
      throw new Error(
        `Unknown deploy target: "${target}". Available: ${[...this.providers.keys()].join(', ')}`
      );
    }
    return provider;
  }

  async plan(options: DeployOptions): Promise<DeployPlan> {
    const analysis = this.analyzer.analyze(
      options.projectDir,
      options.configOverrides as DeployConfig
    );

    const config: DeployConfig = {
      ...analysis.deployConfig,
      ...options.configOverrides,
      target: options.target,
    };

    if (options.noPush) {
      delete config.registry;
    }

    const provider = this.getProvider(options.target);
    const preflight = await provider.preflight(config, options.projectDir);

    return { config, preflight, provider };
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const { config, preflight, provider } = await this.plan(options);

    if (!preflight.passed) {
      const failures = preflight.checks.filter((c) => !c.passed);
      return {
        success: false,
        error: `Preflight failed:\n${failures.map((f) => `  - ${f.message}${f.fix ? ` (${f.fix})` : ''}`).join('\n')}`,
      };
    }

    const analysis = this.analyzer.analyze(options.projectDir);
    const artifacts = this.generator.generate(config, {
      hasTypeScript: analysis.hasTypeScript,
    });

    if (options.dryRun) {
      return { success: true, url: '(dry run)' };
    }

    return provider.deploy(config, artifacts, options.projectDir);
  }

  async status(
    target: DeployTarget,
    config: DeployConfig,
    projectDir: string
  ): Promise<DeployStatus> {
    const provider = this.getProvider(target);
    return provider.status(config, projectDir);
  }

  async destroy(target: DeployTarget, config: DeployConfig, projectDir: string): Promise<void> {
    const provider = this.getProvider(target);
    return provider.destroy(config, projectDir);
  }
}
