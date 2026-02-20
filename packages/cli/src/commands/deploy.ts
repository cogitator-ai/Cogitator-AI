import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { resolve } from 'node:path';
import { log } from '../utils/logger.js';
import type { DeployConfig, DeployTarget } from '@cogitator-ai/types';

interface DeployFlags {
  target?: string;
  config?: string;
  registry?: string;
  push: boolean;
  dryRun?: boolean;
  region?: string;
}

function resolveTarget(
  flag: string | undefined,
  configTarget: DeployTarget | undefined
): DeployTarget {
  const raw = flag ?? configTarget ?? 'docker';
  const valid: DeployTarget[] = ['docker', 'fly', 'railway', 'k8s', 'ssh'];
  if (!valid.includes(raw as DeployTarget)) {
    log.error(`Unknown deploy target: "${raw}"`);
    log.dim(`Available targets: ${valid.join(', ')}`);
    process.exit(1);
  }
  return raw as DeployTarget;
}

async function loadDeployConfig(configPath?: string): Promise<DeployConfig | undefined> {
  try {
    const { loadConfig } = await import('@cogitator-ai/config');
    const config = loadConfig({ configPath });
    return config.deploy;
  } catch {
    return undefined;
  }
}

function buildConfigOverrides(
  flags: DeployFlags,
  fileConfig: DeployConfig | undefined
): Partial<DeployConfig> {
  const overrides: Partial<DeployConfig> = {};

  if (fileConfig) {
    Object.assign(overrides, fileConfig);
  }

  if (flags.registry) {
    overrides.registry = flags.registry;
  }

  if (flags.region) {
    overrides.region = flags.region;
  }

  return overrides;
}

async function runDeploy(flags: DeployFlags): Promise<void> {
  const projectDir = resolve(process.cwd());

  const spinner = ora('Loading configuration...').start();

  const fileConfig = await loadDeployConfig(flags.config);
  const target = resolveTarget(flags.target, fileConfig?.target);
  const configOverrides = buildConfigOverrides(flags, fileConfig);

  spinner.text = 'Analyzing project...';

  const { Deployer } = await import('@cogitator-ai/deploy');
  const deployer = new Deployer();

  const plan = await deployer.plan({
    projectDir,
    target,
    dryRun: flags.dryRun,
    noPush: !flags.push,
    configOverrides,
  });

  spinner.stop();

  console.log();
  log.info(`Deploy plan for ${chalk.bold(target)}`);
  console.log();

  const { config, preflight } = plan;

  console.log(chalk.dim('  Configuration:'));
  console.log(`    Target:   ${chalk.cyan(target)}`);
  if (config.server) console.log(`    Server:   ${chalk.cyan(config.server)}`);
  if (config.port) console.log(`    Port:     ${chalk.cyan(String(config.port))}`);
  if (config.region) console.log(`    Region:   ${chalk.cyan(config.region)}`);
  if (config.registry) console.log(`    Registry: ${chalk.cyan(config.registry)}`);
  if (config.instances) console.log(`    Instances: ${chalk.cyan(String(config.instances))}`);
  console.log();

  if (config.services?.redis || config.services?.postgres) {
    console.log(chalk.dim('  Services:'));
    if (config.services.redis) console.log(`    ${chalk.green('●')} Redis`);
    if (config.services.postgres) console.log(`    ${chalk.green('●')} PostgreSQL`);
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

  const result = await deployer.deploy({
    projectDir,
    target,
    dryRun: false,
    noPush: !flags.push,
    configOverrides,
  });

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
  const fileConfig = await loadDeployConfig(flags.config);
  const target = resolveTarget(flags.target, fileConfig?.target);
  const configOverrides = buildConfigOverrides(flags, fileConfig);

  const spinner = ora('Checking deployment status...').start();

  const { Deployer } = await import('@cogitator-ai/deploy');
  const deployer = new Deployer();

  const deployConfig: DeployConfig = { target, ...configOverrides };
  const status = await deployer.status(target, deployConfig, projectDir);

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
  const fileConfig = await loadDeployConfig(flags.config);
  const target = resolveTarget(flags.target, fileConfig?.target);
  const configOverrides = buildConfigOverrides(flags, fileConfig);

  const spinner = ora(`Destroying ${target} deployment...`).start();

  const { Deployer } = await import('@cogitator-ai/deploy');
  const deployer = new Deployer();

  const deployConfig: DeployConfig = { target, ...configOverrides };

  try {
    await deployer.destroy(target, deployConfig, projectDir);
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
  .option('-t, --target <target>', 'Deploy target (docker, fly, railway, k8s, ssh)')
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
