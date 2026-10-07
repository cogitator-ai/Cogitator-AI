import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  PreflightCheck,
  PreflightResult,
  GeneratedArtifacts,
} from '@cogitator-ai/types';
import type { DeployProvider } from './base.js';
import { run, isCommandAvailable } from '../utils/exec.js';
import { resolveDeployEnv, sanitizeName } from '../utils/env.js';
import { isRegistryAuthenticated } from '../utils/registry-auth.js';
import { imageTag } from '../templates/docker-compose.js';
import { ARTIFACTS_DIR } from '../generator.js';
import { generateProjectArtifacts, secretChecks, writeArtifacts } from './artifacts.js';
import { healthPath, servesHttp } from '../templates/health.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PREFLIGHT_TIMEOUT_MS = 10_000;
const COMPOSE_FILE = 'docker-compose.prod.yml';
const DEFAULT_STARTUP_CHECK_MS = 8_000;
const STARTUP_POLL_MS = 1_000;
const LOG_TAIL_LINES = '30';

export interface DockerProviderOptions {
  /**
   * How long the app container must keep running after `docker compose up`
   * for the deploy to count as a success. A container that exits or restarts
   * within it fails the deploy with its logs. 8 seconds by default, 0 checks once.
   */
  startupCheckMs?: number;
}

interface ContainerState {
  status: string;
  restarts: number;
  exitCode: number;
}

function parseContainerState(output: string): ContainerState | undefined {
  const [status, restarts, exitCode] = output.trim().split(/\s+/);
  if (!status) return undefined;
  return {
    status,
    restarts: Number.parseInt(restarts ?? '0', 10) || 0,
    exitCode: Number.parseInt(exitCode ?? '0', 10) || 0,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DockerProvider implements DeployProvider {
  readonly name = 'docker';
  private readonly startupCheckMs: number;

  constructor(options: DockerProviderOptions = {}) {
    this.startupCheckMs = Math.max(options.startupCheckMs ?? DEFAULT_STARTUP_CHECK_MS, 0);
  }

  private composeArgs(config: DeployConfig, projectDir: string, ...rest: string[]): string[] {
    return [
      'compose',
      '-p',
      sanitizeName(config.image ?? 'cogitator-app'),
      '-f',
      join(projectDir, ARTIFACTS_DIR, COMPOSE_FILE),
      ...rest,
    ];
  }

  async preflight(config: DeployConfig, projectDir: string): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];

    const dockerAvailable = isCommandAvailable('docker');
    checks.push({
      name: 'Docker installed',
      passed: dockerAvailable,
      message: dockerAvailable ? 'Docker is available' : 'Docker is not installed',
      fix: dockerAvailable ? undefined : 'Install Docker: https://docs.docker.com/get-docker/',
    });

    if (dockerAvailable) {
      const daemonRunning = run('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: PREFLIGHT_TIMEOUT_MS,
      }).success;
      checks.push({
        name: 'Docker daemon running',
        passed: daemonRunning,
        message: daemonRunning ? 'Docker daemon is running' : 'Docker daemon is not running',
        fix: daemonRunning ? undefined : 'Start Docker Desktop or run: sudo systemctl start docker',
      });

      const composeAvailable = run('docker', ['compose', 'version'], {
        timeout: PREFLIGHT_TIMEOUT_MS,
      }).success;
      checks.push({
        name: 'Docker Compose available',
        passed: composeAvailable,
        message: composeAvailable
          ? 'Docker Compose v2 is available'
          : 'Docker Compose v2 plugin is not available',
        fix: composeAvailable ? undefined : 'Install it: https://docs.docker.com/compose/install/',
      });
    }

    if (config.registry) {
      const authenticated = isRegistryAuthenticated(config.registry);
      checks.push({
        name: 'Registry authentication',
        passed: authenticated,
        message: authenticated
          ? `Authenticated with ${config.registry}`
          : `Not authenticated with ${config.registry}`,
        fix: authenticated ? undefined : `Run: docker login ${config.registry.split('/')[0]}`,
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
    const env = resolveDeployEnv(projectDir);
    const tag = imageTag(config);

    const buildResult = run(
      'docker',
      ['build', '-f', join(outputDir, 'Dockerfile'), '-t', tag, projectDir],
      { cwd: projectDir, env }
    );
    if (!buildResult.success) {
      return { success: false, error: `Docker build failed: ${buildResult.error}` };
    }

    if (config.registry) {
      const pushResult = run('docker', ['push', tag], { env });
      if (!pushResult.success) {
        return { success: false, error: `Docker push failed: ${pushResult.error}` };
      }
    }

    const upResult = run('docker', this.composeArgs(config, projectDir, 'up', '-d', '--no-build'), {
      cwd: projectDir,
      env,
    });
    if (!upResult.success) {
      return { success: false, error: `docker compose up failed: ${upResult.error}` };
    }

    const startupError = await this.verifyStartup(config, projectDir, env);
    if (startupError) return { success: false, error: startupError };

    if (!servesHttp(config)) return { success: true };

    const port = config.port ?? 3000;
    const url = `http://localhost:${port}`;
    const health = healthPath(config);
    return {
      success: true,
      url,
      endpoints: { api: url, ...(health ? { health: `${url}${health}` } : {}) },
    };
  }

  /**
   * Watches the app container for `startupCheckMs` after it starts. A
   * container that exits or restarts in that time (a missing secret, a
   * crash at import) fails the deploy with its last log lines, instead of
   * the deploy reporting success while it restarts in a loop.
   */
  private async verifyStartup(
    config: DeployConfig,
    projectDir: string,
    env: NodeJS.ProcessEnv
  ): Promise<string | undefined> {
    const ps = run('docker', this.composeArgs(config, projectDir, 'ps', '-q', '-a', 'app'), {
      cwd: projectDir,
      env,
    });
    const containerId = ps.output.trim().split('\n')[0];
    if (!ps.success || !containerId) {
      return 'The app container was not created by docker compose up';
    }

    const deadline = Date.now() + this.startupCheckMs;
    for (;;) {
      const inspect = run(
        'docker',
        ['inspect', '-f', '{{.State.Status}} {{.RestartCount}} {{.State.ExitCode}}', containerId],
        { env }
      );
      const state = inspect.success ? parseContainerState(inspect.output) : undefined;
      if (state && (state.status !== 'running' || state.restarts > 0)) {
        const logs = run(
          'docker',
          this.composeArgs(
            config,
            projectDir,
            'logs',
            '--no-color',
            '--tail',
            LOG_TAIL_LINES,
            'app'
          ),
          { cwd: projectDir, env }
        );
        return [
          `The app container is ${state.status} (exit code ${state.exitCode}, ${state.restarts} restarts) right after starting.`,
          logs.output.trim() ? `Last log lines:\n${logs.output.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(Math.min(STARTUP_POLL_MS, Math.max(deadline - Date.now(), 0)));
    }
  }

  async status(config: DeployConfig, projectDir: string): Promise<DeployStatus> {
    if (!existsSync(join(projectDir, ARTIFACTS_DIR, COMPOSE_FILE))) return { running: false };

    const result = run(
      'docker',
      this.composeArgs(config, projectDir, 'ps', '--services', '--filter', 'status=running'),
      { cwd: projectDir, env: resolveDeployEnv(projectDir) }
    );
    if (!result.success) return { running: false };

    const services = result.output.split('\n').filter((line) => line.trim().length > 0);
    const running = services.includes('app');
    return {
      running,
      instances: running ? 1 : 0,
      url: running && servesHttp(config) ? `http://localhost:${config.port ?? 3000}` : undefined,
    };
  }

  async destroy(config: DeployConfig, projectDir: string): Promise<void> {
    if (!existsSync(join(projectDir, ARTIFACTS_DIR, COMPOSE_FILE))) {
      throw new Error('No docker deployment found (missing .cogitator/docker-compose.prod.yml)');
    }
    const result = run('docker', this.composeArgs(config, projectDir, 'down'), {
      cwd: projectDir,
      env: resolveDeployEnv(projectDir),
    });
    if (!result.success) {
      throw new Error(`docker compose down failed: ${result.error}`);
    }
  }
}
