import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findConfigFile, loadConfig, loadEnvConfig } from '@cogitator-ai/config';
import { Deployer, type DeployPlan } from '@cogitator-ai/deploy';
import { log } from '../utils/logger.js';
import type { DeployConfig, DeployResult, DeployStatus, DeployTarget } from '@cogitator-ai/types';

export interface DeployFlags {
  target?: string;
  config?: string;
  registry?: string;
  push: boolean;
  dryRun?: boolean;
  region?: string;
}

function isDeployTarget(value: string, available: readonly string[]): value is DeployTarget {
  return available.includes(value);
}

function resolveTarget(requested: string | undefined, available: readonly string[]): DeployTarget {
  const raw = requested ?? 'docker';
  if (!isDeployTarget(raw, available)) {
    log.error(`Unsupported deploy target: "${raw}"`);
    log.dim(`Available targets: ${available.join(', ')}`);
    process.exit(1);
  }
  return raw;
}

/** What `cogitator deploy` hands the deployer: the config file, the target's name and the settings over the file. */
export interface DeployInputs {
  /** The `-c` file, else the project's own config file (`findConfigFile`) */
  configPath?: string;
  /** `--target`, else `deploy.target` from the environment or the config file */
  target?: string;
  /** `COGITATOR_DEPLOY_*` variables and flags, applied over the config file's deploy section */
  overrides: Partial<DeployConfig>;
}

/**
 * Resolves the config file and the settings of a deploy. The config file is
 * the one passed with `-c` (an error when it does not exist), else the
 * project's own, found like `loadConfig` finds it. The analyzer reads the
 * model, memory and deploy section from that same file.
 */
export function resolveDeployInputs(
  projectDir: string,
  flags: Pick<DeployFlags, 'config' | 'target' | 'registry' | 'region'>
): DeployInputs {
  const configPath = flags.config ? resolve(projectDir, flags.config) : findConfigFile(projectDir);
  if (flags.config && configPath && !existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const fileDeploy = configPath ? loadConfig({ configPath, skipEnv: true }).deploy : undefined;
  const envDeploy = loadEnvConfig().deploy ?? {};
  const overrides: Partial<DeployConfig> = {
    ...(envDeploy.target ? { target: envDeploy.target } : {}),
    ...(envDeploy.port ? { port: envDeploy.port } : {}),
    ...(envDeploy.registry ? { registry: envDeploy.registry } : {}),
    ...(flags.registry ? { registry: flags.registry } : {}),
    ...(flags.region ? { region: flags.region } : {}),
  };

  return {
    configPath,
    target: flags.target ?? overrides.target ?? fileDeploy?.target,
    overrides,
  };
}

function loadDeployInputs(projectDir: string, flags: DeployFlags): DeployInputs {
  try {
    return resolveDeployInputs(projectDir, flags);
  } catch (error) {
    log.error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function runDeploy(flags: DeployFlags): Promise<void> {
  const projectDir = resolve(process.cwd());

  const deployer = new Deployer();
  const inputs = loadDeployInputs(projectDir, flags);
  const target = resolveTarget(inputs.target, deployer.availableTargets());
  const configOverrides = inputs.overrides;

  const spinner = ora('Analyzing project...').start();
  let plan: DeployPlan;
  try {
    plan = await deployer.plan({
      projectDir,
      target,
      dryRun: flags.dryRun,
      noPush: !flags.push,
      configOverrides,
      configPath: inputs.configPath,
    });
  } catch (error) {
    spinner.fail('Failed to plan deployment');
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  spinner.stop();

  console.log();
  log.info(`Deploy plan for ${chalk.bold(target)}`);
  console.log();

  const { config, preflight } = plan;

  console.log(chalk.dim('  Configuration:'));
  if (inputs.configPath) console.log(`    Config:   ${chalk.cyan(inputs.configPath)}`);
  console.log(`    Target:   ${chalk.cyan(target)}`);
  if (config.kind) console.log(`    Kind:     ${chalk.cyan(config.kind)}`);
  if (config.server) console.log(`    Server:   ${chalk.cyan(config.server)}`);
  if (config.port) console.log(`    Port:     ${chalk.cyan(String(config.port))}`);
  if (config.region) console.log(`    Region:   ${chalk.cyan(config.region)}`);
  if (config.registry) console.log(`    Registry: ${chalk.cyan(config.registry)}`);
  if (config.image) console.log(`    App:      ${chalk.cyan(config.image)}`);
  if (config.instances) console.log(`    Instances: ${chalk.cyan(String(config.instances))}`);
  console.log();

  if (plan.warnings.length > 0) {
    console.log(chalk.dim('  Warnings:'));
    for (const warning of plan.warnings) {
      console.log(`    ${chalk.yellow('!')} ${warning}`);
    }
    console.log();
  }

  if (config.services?.redis || config.services?.postgres) {
    const provisioned = target === 'docker';
    const icon = provisioned ? chalk.green('●') : chalk.yellow('○');
    const note = (variable: string) =>
      provisioned ? '' : chalk.dim(` (not provisioned on ${target}, set ${variable})`);
    console.log(chalk.dim('  Services:'));
    if (config.services.redis) console.log(`    ${icon} Redis${note('REDIS_URL')}`);
    if (config.services.postgres) console.log(`    ${icon} PostgreSQL${note('DATABASE_URL')}`);
    console.log();
  }

  if (config.volumes && config.volumes.length > 0) {
    console.log(chalk.dim('  Volumes:'));
    for (const volume of config.volumes) {
      console.log(`    ${chalk.green('●')} ${volume.path}`);
    }
    console.log();
  }

  if (config.secrets && config.secrets.length > 0) {
    console.log(chalk.dim('  Required secrets:'));
    for (const secret of config.secrets) {
      console.log(`    ${chalk.yellow('○')} ${secret}`);
    }
    console.log();
  }

  console.log(chalk.dim('  Preflight checks:'));
  for (const check of preflight.checks) {
    const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
    console.log(`    ${icon} ${check.message}`);
  }
  console.log();

  if (!preflight.passed) {
    log.error('Preflight checks failed');
    console.log();
    const failures = preflight.checks.filter((c) => !c.passed);
    for (const failure of failures) {
      if (failure.fix) {
        log.dim(`  Fix: ${failure.fix}`);
      }
    }
    process.exit(1);
  }

  if (flags.dryRun) {
    log.success('Dry run completed — no changes made');
    return;
  }

  const deploySpinner = ora('Deploying...').start();

  let result: DeployResult;
  try {
    result = await deployer.deploy({
      projectDir,
      target,
      dryRun: false,
      noPush: !flags.push,
      configOverrides,
      configPath: inputs.configPath,
    });
  } catch (error) {
    deploySpinner.fail('Deploy failed');
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!result.success) {
    deploySpinner.fail('Deploy failed');
    log.error(result.error ?? 'Unknown error');
    process.exit(1);
  }

  deploySpinner.succeed('Deployed successfully');
  console.log();

  if (result.url) {
    log.success(`URL: ${chalk.underline(result.url)}`);
  }

  if (result.endpoints) {
    if (result.endpoints.api) {
      console.log(`  API:    ${chalk.cyan(result.endpoints.api)}`);
    }
    if (result.endpoints.a2a) {
      console.log(`  A2A:    ${chalk.cyan(result.endpoints.a2a)}`);
    }
    if (result.endpoints.health) {
      console.log(`  Health: ${chalk.cyan(result.endpoints.health)}`);
    }
  }

  console.log();
  log.dim('Commands:');
  console.log(`  cogitator deploy status   — check deployment status`);
  console.log(`  cogitator deploy destroy  — tear down deployment`);
  console.log();
}

async function runDeployStatus(flags: DeployFlags): Promise<void> {
  const projectDir = resolve(process.cwd());
  const deployer = new Deployer();
  const inputs = loadDeployInputs(projectDir, flags);
  const target = resolveTarget(inputs.target, deployer.availableTargets());

  const spinner = ora('Checking deployment status...').start();

  const deployConfig: DeployConfig = { ...inputs.overrides, target };
  let status: DeployStatus;
  try {
    status = await deployer.status(target, deployConfig, projectDir, {
      configPath: inputs.configPath,
    });
  } catch (error) {
    spinner.fail('Failed to check status');
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  spinner.stop();
  console.log();

  if (status.running) {
    log.success(`Deployment is ${chalk.green('running')}`);
    if (status.url) console.log(`  URL:       ${chalk.cyan(status.url)}`);
    if (status.instances) console.log(`  Instances: ${chalk.cyan(String(status.instances))}`);
    if (status.uptime) console.log(`  Uptime:    ${chalk.cyan(status.uptime)}`);
  } else {
    log.warn('Deployment is not running');
    log.dim('Run "cogitator deploy" to deploy your project');
  }

  console.log();
}

async function runDeployDestroy(flags: DeployFlags): Promise<void> {
  const projectDir = resolve(process.cwd());
  const deployer = new Deployer();
  const inputs = loadDeployInputs(projectDir, flags);
  const target = resolveTarget(inputs.target, deployer.availableTargets());

  const spinner = ora(`Destroying ${target} deployment...`).start();

  const deployConfig: DeployConfig = { ...inputs.overrides, target };

  try {
    await deployer.destroy(target, deployConfig, projectDir, { configPath: inputs.configPath });
    spinner.succeed('Deployment destroyed');
  } catch (err) {
    spinner.fail('Failed to destroy deployment');
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export const deployCommand = new Command('deploy')
  .description('Deploy your Cogitator project')
  .argument('[action]', 'Action to perform: status, destroy')
  .option('-t, --target <target>', 'Deploy target (docker, fly)')
  .option('-c, --config <path>', 'Config file path')
  .option('--registry <url>', 'Container registry URL')
  .option('--no-push', 'Skip pushing image to registry')
  .option('--dry-run', 'Show deploy plan without executing')
  .option('--region <region>', 'Deploy region')
  .action(async (action: string | undefined, flags: DeployFlags) => {
    switch (action) {
      case 'status':
        await runDeployStatus(flags);
        break;
      case 'destroy':
        await runDeployDestroy(flags);
        break;
      case undefined:
        await runDeploy(flags);
        break;
      default:
        log.error(`Unknown action: "${action}"`);
        log.dim('Available actions: status, destroy');
        process.exit(1);
    }
  });
