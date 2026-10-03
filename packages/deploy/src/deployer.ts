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
import { ProjectAnalyzer, type AnalyzerResult } from './analyzer.js';

/** A built-in target, or the name of a provider registered via `registerProvider`. */
export type DeployTargetName = DeployTarget | (string & {});

const BUILTIN_TARGETS: readonly DeployTarget[] = ['docker', 'fly'];

function isBuiltinTarget(target: string): target is DeployTarget {
  return BUILTIN_TARGETS.some((t) => t === target);
}

export interface DeployOptions {
  projectDir: string;
  target: DeployTargetName;
  dryRun?: boolean;
  noPush?: boolean;
  configOverrides?: Partial<DeployConfig>;
}

export interface DeployPlan {
  config: DeployConfig;
  preflight: PreflightResult;
  provider: DeployProvider;
  warnings: string[];
  analysis: AnalyzerResult;
}

export class Deployer {
  private providers = new Map<string, DeployProvider>();
  private analyzer = new ProjectAnalyzer();

  constructor() {
    this.registerProvider(new DockerProvider());
    this.registerProvider(new FlyProvider());
  }

  registerProvider(provider: DeployProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** Targets that have a registered provider. */
  availableTargets(): string[] {
    return [...this.providers.keys()];
  }

  getProvider(target: DeployTargetName): DeployProvider {
    const provider = this.providers.get(target);
    if (!provider) {
      throw new Error(
        `Unknown deploy target: "${target}". Available: ${this.availableTargets().join(', ')}`
      );
    }
    return provider;
  }

  private resolveConfig(
    projectDir: string,
    target: DeployTargetName,
    overrides: Partial<DeployConfig> | undefined
  ): { config: DeployConfig; analysis: AnalyzerResult } {
    const builtin = isBuiltinTarget(target) ? { target } : {};
    const analysis = this.analyzer.analyze(projectDir, { ...overrides, ...builtin });
    return { config: { ...analysis.deployConfig, ...builtin }, analysis };
  }

  async plan(options: DeployOptions): Promise<DeployPlan> {
    const provider = this.getProvider(options.target);
    const { config, analysis } = this.resolveConfig(
      options.projectDir,
      options.target,
      options.configOverrides
    );

    if (options.noPush) {
      delete config.registry;
    }

    const preflight = await provider.preflight(config, options.projectDir);

    return { config, preflight, provider, warnings: analysis.warnings, analysis };
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

    const artifacts = await provider.generate(config, options.projectDir);

    if (options.dryRun) {
      return { success: true, url: '(dry run)' };
    }

    return provider.deploy(config, artifacts, options.projectDir);
  }

  async status(
    target: DeployTargetName,
    config: DeployConfig,
    projectDir: string
  ): Promise<DeployStatus> {
    const provider = this.getProvider(target);
    const resolved = this.resolveConfig(projectDir, target, config).config;
    return provider.status(resolved, projectDir);
  }

  async destroy(target: DeployTargetName, config: DeployConfig, projectDir: string): Promise<void> {
    const provider = this.getProvider(target);
    const resolved = this.resolveConfig(projectDir, target, config).config;
    return provider.destroy(resolved, projectDir);
  }
}
