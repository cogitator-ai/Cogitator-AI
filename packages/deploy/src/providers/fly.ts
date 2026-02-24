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

export class FlyProvider implements DeployProvider {
  readonly name = 'fly';

  async preflight(config: DeployConfig, _projectDir: string): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];

    const flyAvailable = isCommandAvailable('flyctl') || isCommandAvailable('fly');
    checks.push({
      name: 'flyctl installed',
      passed: flyAvailable,
      message: flyAvailable ? 'flyctl is available' : 'flyctl is not installed',
      fix: flyAvailable ? undefined : 'Install flyctl: curl -L https://fly.io/install.sh | sh',
    });

    if (flyAvailable) {
      const authResult = exec('flyctl auth whoami');
      checks.push({
        name: 'Fly.io authenticated',
        passed: authResult.success,
        message: authResult.success
          ? `Logged in as ${authResult.output}`
          : 'Not authenticated with Fly.io',
        fix: authResult.success ? undefined : 'Run: flyctl auth login',
      });
    } else {
      checks.push({
        name: 'Fly.io authenticated',
        passed: false,
        message: 'Cannot check auth — flyctl not installed',
        fix: 'Install flyctl first',
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
      const filePath =
        file.path === 'fly.toml' ? join(projectDir, file.path) : join(outputDir, file.path);
      writeFileSync(filePath, file.content);
    }

    const app = config.image ?? 'cogitator-app';

    const launchCheck = exec('flyctl apps list --json', { cwd: projectDir });
    let appExists = false;
    if (launchCheck.success) {
      try {
        const apps = JSON.parse(launchCheck.output) as Array<{ Name: string }>;
        appExists = apps.some((a) => a.Name === app);
      } catch {}
    }

    if (!appExists) {
      const createResult = exec(`flyctl apps create ${app} --json`, { cwd: projectDir });
      if (!createResult.success) {
        return { success: false, error: `Failed to create Fly app: ${createResult.error}` };
      }
    }

    const secretPairs = (config.secrets ?? [])
      .filter((secret) => !!process.env[secret])
      .map((secret) => `${secret}=${process.env[secret]}`)
      .join('\n');
    if (secretPairs) {
      exec(`flyctl secrets import --app ${app}`, { cwd: projectDir, input: secretPairs });
    }

    const deployResult = exec(
      `flyctl deploy --app ${app} --dockerfile ${join(outputDir, 'Dockerfile')} --now`,
      { cwd: projectDir }
    );

    if (!deployResult.success) {
      return { success: false, error: `Fly deploy failed: ${deployResult.error}` };
    }

    const url = `https://${app}.fly.dev`;
    return {
      success: true,
      url,
      endpoints: {
        api: url,
        a2a: `${url}/.well-known/agent.json`,
        health: `${url}/health`,
      },
    };
  }

  async status(config: DeployConfig, projectDir: string): Promise<DeployStatus> {
    const app = config.image ?? 'cogitator-app';
    const result = exec(`flyctl status --app ${app} --json`, { cwd: projectDir });

    if (!result.success) return { running: false };

    try {
      const status = JSON.parse(result.output) as { Deployed: boolean; Hostname: string };
      return { running: status.Deployed, url: `https://${status.Hostname}` };
    } catch {
      return { running: false };
    }
  }

  async destroy(config: DeployConfig, projectDir: string): Promise<void> {
    const app = config.image ?? 'cogitator-app';
    exec(`flyctl apps destroy ${app} --yes`, { cwd: projectDir });
  }
}
