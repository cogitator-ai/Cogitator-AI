import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  PreflightCheck,
  PreflightResult,
  GeneratedArtifacts,
} from '@cogitator-ai/types';
import type { DeployProvider } from './base.js';
import { run, isCommandAvailable, type ExecResult, type RunOptions } from '../utils/exec.js';
import { resolveDeployEnv } from '../utils/env.js';
import { generateProjectArtifacts, secretChecks, writeArtifacts } from './artifacts.js';
import { healthPath, servesHttp } from '../templates/health.js';
import { volumeName } from '../volumes.js';
import { join } from 'node:path';

const DEFAULT_REGION = 'iad';

const PREFLIGHT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveFlyBinary(): string | null {
  if (isCommandAvailable('flyctl')) return 'flyctl';
  if (isCommandAvailable('fly')) return 'fly';
  return null;
}

export function formatSecretsForImport(
  secrets: readonly string[],
  env: NodeJS.ProcessEnv
): { payload: string; skipped: string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const secret of secrets) {
    const value = env[secret];
    if (!value) continue;
    if (/[\r\n]/.test(value)) {
      skipped.push(secret);
      continue;
    }
    lines.push(`${secret}=${value}`);
  }
  return { payload: lines.join('\n'), skipped };
}

export class FlyProvider implements DeployProvider {
  readonly name = 'fly';

  private fly(args: string[], options: RunOptions = {}): ExecResult {
    const binary = resolveFlyBinary();
    if (!binary) return { success: false, output: '', error: 'flyctl is not installed' };
    return run(binary, args, options);
  }

  private appName(config: DeployConfig): string {
    return config.image ?? 'cogitator-app';
  }

  async preflight(config: DeployConfig, projectDir: string): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];

    const binary = resolveFlyBinary();
    checks.push({
      name: 'flyctl installed',
      passed: binary !== null,
      message: binary ? `${binary} is available` : 'flyctl is not installed',
      fix: binary ? undefined : 'Install flyctl: curl -L https://fly.io/install.sh | sh',
    });

    if (binary) {
      const authResult = run(binary, ['auth', 'whoami'], { timeout: PREFLIGHT_TIMEOUT_MS });
      checks.push({
        name: 'Fly.io authenticated',
        passed: authResult.success,
        message: authResult.success
          ? `Logged in as ${authResult.output}`
          : 'Not authenticated with Fly.io',
        fix: authResult.success ? undefined : `Run: ${binary} auth login`,
      });
    } else {
      checks.push({
        name: 'Fly.io authenticated',
        passed: false,
        message: 'Cannot check auth — flyctl not installed',
        fix: 'Install flyctl first',
      });
    }

    checks.push(...secretChecks(config.secrets ?? [], resolveDeployEnv(projectDir)));

    return {
      checks,
      passed: checks.every((c) => c.passed),
    };
  }

  async generate(config: DeployConfig, projectDir: string): Promise<GeneratedArtifacts> {
    return generateProjectArtifacts(config, projectDir);
  }

  async deploy(
    config: DeployConfig,
    artifacts: GeneratedArtifacts,
    projectDir: string
  ): Promise<DeployResult> {
    const outputDir = writeArtifacts(projectDir, artifacts);
    const app = this.appName(config);
    const env = resolveDeployEnv(projectDir);

    const appExists = this.fly(['status', '--app', app, '--json'], { cwd: projectDir }).success;
    if (!appExists) {
      const createResult = this.fly(['apps', 'create', app], { cwd: projectDir });
      if (!createResult.success) {
        return {
          success: false,
          error: `Failed to create Fly app "${app}": ${createResult.error}`,
        };
      }
    }

    const { payload, skipped } = formatSecretsForImport(config.secrets ?? [], env);
    if (skipped.length > 0) {
      return {
        success: false,
        error: `Multi-line secret values are not supported by "fly secrets import": ${skipped.join(', ')}`,
      };
    }
    if (payload) {
      const secretsResult = this.fly(['secrets', 'import', '--app', app, '--stage'], {
        cwd: projectDir,
        input: payload,
      });
      if (!secretsResult.success) {
        return { success: false, error: `Failed to import Fly secrets: ${secretsResult.error}` };
      }
    }

    const volumeError = this.ensureVolumes(config, app, projectDir);
    if (volumeError) return { success: false, error: volumeError };

    const deployResult = this.fly(
      [
        'deploy',
        projectDir,
        '--app',
        app,
        '--config',
        join(outputDir, 'fly.toml'),
        '--dockerfile',
        join(outputDir, 'Dockerfile'),
        '--now',
      ],
      { cwd: projectDir }
    );
    if (!deployResult.success) {
      return { success: false, error: `Fly deploy failed: ${deployResult.error}` };
    }

    const instances = config.instances ?? 1;
    if (instances > 1) {
      const scaleResult = this.fly(['scale', 'count', String(instances), '--app', app, '--yes'], {
        cwd: projectDir,
      });
      if (!scaleResult.success) {
        return { success: false, error: `Fly scale failed: ${scaleResult.error}` };
      }
    }

    if (!servesHttp(config)) return { success: true };

    const url = `https://${app}.fly.dev`;
    const health = healthPath(config);
    return {
      success: true,
      url,
      endpoints: {
        api: url,
        a2a: `${url}/.well-known/agent.json`,
        ...(health ? { health: `${url}${health}` } : {}),
      },
    };
  }

  /** Creates the Fly volume `fly.toml` mounts when the app has none of that name yet. */
  private ensureVolumes(config: DeployConfig, app: string, projectDir: string): string | undefined {
    const volume = config.volumes?.[0];
    if (!volume) return undefined;
    const name = volumeName(volume);

    const list = this.fly(['volumes', 'list', '--app', app, '--json'], { cwd: projectDir });
    if (!list.success) return `Failed to list Fly volumes: ${list.error}`;
    let existing: unknown;
    try {
      existing = JSON.parse(list.output || '[]');
    } catch {
      existing = [];
    }
    const exists =
      Array.isArray(existing) && existing.some((entry) => isRecord(entry) && entry.name === name);
    if (exists) return undefined;

    const create = this.fly(
      [
        'volumes',
        'create',
        name,
        '--app',
        app,
        '--region',
        config.region ?? DEFAULT_REGION,
        '--size',
        String(volume.size ?? 1),
        '--yes',
      ],
      { cwd: projectDir }
    );
    return create.success ? undefined : `Failed to create Fly volume "${name}": ${create.error}`;
  }

  async status(config: DeployConfig, projectDir: string): Promise<DeployStatus> {
    const result = this.fly(['status', '--app', this.appName(config), '--json'], {
      cwd: projectDir,
    });
    if (!result.success) return { running: false };

    let status: unknown;
    try {
      status = JSON.parse(result.output);
    } catch {
      return { running: false };
    }
    if (!isRecord(status)) return { running: false };

    const machines = Array.isArray(status.Machines) ? status.Machines : [];
    const started = machines.filter((m) => isRecord(m) && m.state === 'started').length;
    const hostname = typeof status.Hostname === 'string' ? status.Hostname : undefined;
    const deployed = status.Deployed === true || started > 0;

    return {
      running: deployed,
      url: hostname ? `https://${hostname}` : undefined,
      instances: machines.length > 0 ? started : undefined,
    };
  }

  async destroy(config: DeployConfig, projectDir: string): Promise<void> {
    const app = this.appName(config);
    const result = this.fly(['apps', 'destroy', app, '--yes'], { cwd: projectDir });
    if (!result.success) {
      throw new Error(`Failed to destroy Fly app "${app}": ${result.error}`);
    }
  }
}
