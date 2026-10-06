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
import { ProjectAnalyzer, type AnalyzeOptions, type AnalyzerResult } from './analyzer.js';

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
  /** Config file to read the model, memory and deploy section from, `findConfigFile(projectDir)` by default */
  configPath?: string;
  /** Environment the deployment takes its secrets from, the project's `.env` under the process environment by default */
  env?: NodeJS.ProcessEnv;
}

/** Where `status` and `destroy` read the project config from. */
export interface DeployLookupOptions {
  configPath?: string;
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
    overrides: Partial<DeployConfig> | undefined,
    options: AnalyzeOptions = {}
  ): { config: DeployConfig; analysis: AnalyzerResult } {
    const builtin = isBuiltinTarget(target) ? { target } : {};
    const analysis = this.analyzer.analyze(projectDir, { ...overrides, ...builtin }, options);
    return { config: { ...analysis.deployConfig, ...builtin }, analysis };
  }

  /**
   * What deploying would do: the resolved config, and a preflight made of
   * the project checks (package.json, project kind, start script, secrets)
   * followed by the target provider's own.
   */
  async plan(options: DeployOptions): Promise<DeployPlan> {
    const provider = this.getProvider(options.target);
    const { config, analysis } = this.resolveConfig(
      options.projectDir,
      options.target,
      options.configOverrides,
      { configPath: options.configPath, env: options.env }
    );

    if (options.noPush) {
      delete config.registry;
    }

    const providerPreflight = await provider.preflight(config, options.projectDir);
    const checks = [...analysis.checks, ...providerPreflight.checks];
    const preflight: PreflightResult = {
      checks,
      passed: providerPreflight.passed && checks.every((c) => c.passed),
    };

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
    projectDir: string,
    options: DeployLookupOptions = {}
  ): Promise<DeployStatus> {
    const provider = this.getProvider(target);
    const resolved = this.resolveConfig(projectDir, target, config, options).config;
    return provider.status(resolved, projectDir);
  }

  async destroy(
    target: DeployTargetName,
    config: DeployConfig,
    projectDir: string,
    options: DeployLookupOptions = {}
  ): Promise<void> {
    const provider = this.getProvider(target);
    const resolved = this.resolveConfig(projectDir, target, config, options).config;
    return provider.destroy(resolved, projectDir);
  }
}
