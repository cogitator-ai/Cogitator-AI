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
import { ARTIFACTS_DIR, ArtifactGenerator } from '../generator.js';
import { secretChecks, writeArtifacts } from './artifacts.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PREFLIGHT_TIMEOUT_MS = 10_000;
const COMPOSE_FILE = 'docker-compose.prod.yml';

export class DockerProvider implements DeployProvider {
  readonly name = 'docker';

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
    return new ArtifactGenerator().generate(config, {
      hasTypeScript: existsSync(join(projectDir, 'tsconfig.json')),
    });
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

    const port = config.port ?? 3000;
    const healthPath = config.health?.path ?? '/health';
    const url = `http://localhost:${port}`;
    return {
      success: true,
      url,
      endpoints: {
        api: url,
        health: `${url}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`,
      },
    };
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
    return {
      running: services.includes('app'),
      instances: services.includes('app') ? 1 : 0,
      url: services.includes('app') ? `http://localhost:${config.port ?? 3000}` : undefined,
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
