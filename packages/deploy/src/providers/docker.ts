import type {
  DeployConfig,
  DeployResult,
  DeployStatus,
  PreflightCheck,
  PreflightResult,
  GeneratedArtifacts,
} from '@cogitator-ai/types';
import type { DeployProvider } from './base.js';
import { exec, isCommandAvailable } from '../utils/exec.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class DockerProvider implements DeployProvider {
  readonly name = 'docker';

  async preflight(config: DeployConfig, _projectDir: string): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];

    const dockerAvailable = isCommandAvailable('docker');
    checks.push({
      name: 'Docker installed',
      passed: dockerAvailable,
      message: dockerAvailable ? 'Docker is available' : 'Docker is not installed',
      fix: dockerAvailable ? undefined : 'Install Docker: https://docs.docker.com/get-docker/',
    });

    if (dockerAvailable) {
      const daemonRunning = exec('docker info').success;
      checks.push({
        name: 'Docker daemon running',
        passed: daemonRunning,
        message: daemonRunning ? 'Docker daemon is running' : 'Docker daemon is not running',
        fix: daemonRunning ? undefined : 'Start Docker Desktop or run: sudo systemctl start docker',
      });
    }

    if (config.registry) {
      const loginCheck = exec(`docker login ${config.registry} --get-login`);
      checks.push({
        name: 'Registry authentication',
        passed: loginCheck.success,
        message: loginCheck.success
          ? `Authenticated with ${config.registry}`
          : `Not authenticated with ${config.registry}`,
        fix: loginCheck.success ? undefined : `Run: docker login ${config.registry}`,
      });
    }

    for (const secret of config.secrets ?? []) {
      const isSet = !!process.env[secret];
      checks.push({
        name: `Secret: ${secret}`,
        passed: isSet,
        message: isSet ? `${secret} is set` : `${secret} is not set`,
        fix: isSet ? undefined : `Set environment variable: export ${secret}=<value>`,
      });
    }

    return {
      checks,
      passed: checks.every((c) => c.passed),
    };
  }

  async generate(config: DeployConfig, _projectDir: string): Promise<GeneratedArtifacts> {
    const { ArtifactGenerator } = await import('../generator.js');
    const generator = new ArtifactGenerator();
    return generator.generate(config, { hasTypeScript: true });
  }

  async deploy(
    config: DeployConfig,
    artifacts: GeneratedArtifacts,
    projectDir: string
  ): Promise<DeployResult> {
    const outputDir = join(projectDir, artifacts.outputDir);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    for (const file of artifacts.files) {
      writeFileSync(join(outputDir, file.path), file.content);
    }

    const image = config.image ?? 'cogitator-app';
    const tag = config.registry ? `${config.registry}/${image}:latest` : `${image}:latest`;

    const buildResult = exec(
      `docker build -f ${join(outputDir, 'Dockerfile')} -t ${tag} ${projectDir}`,
      { cwd: projectDir }
    );

    if (!buildResult.success) {
      return { success: false, error: `Docker build failed: ${buildResult.error}` };
    }

    if (config.registry) {
      const pushResult = exec(`docker push ${tag}`);
      if (!pushResult.success) {
        return { success: false, error: `Docker push failed: ${pushResult.error}` };
      }
    }

    return {
      success: true,
      endpoints: {
        api: `http://localhost:${config.port ?? 3000}`,
        health: `http://localhost:${config.port ?? 3000}/health`,
      },
    };
  }

  async status(_config: DeployConfig, projectDir: string): Promise<DeployStatus> {
    const composePath = join(projectDir, '.cogitator', 'docker-compose.prod.yml');
    if (!existsSync(composePath)) return { running: false };
    const result = exec(`docker-compose -f ${composePath} ps --services --filter status=running`, {
      cwd: projectDir,
    });
    return { running: result.success && result.output.trim().length > 0 };
  }

  async destroy(_config: DeployConfig, projectDir: string): Promise<void> {
    const composePath = join(projectDir, '.cogitator', 'docker-compose.prod.yml');
    if (existsSync(composePath)) {
      exec(`docker-compose -f ${composePath} down -v`, { cwd: projectDir });
    }
  }
}
