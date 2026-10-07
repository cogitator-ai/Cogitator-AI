import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { findConfigFile, loadConfig, loadEnvConfig } from '@cogitator-ai/config';
import { Deployer, type DeployPlan } from '@cogitator-ai/deploy';
import { log } from '../utils/logger.js';
import {
  CommandError,
  UsageError,
  errorMessage,
  EXIT,
  examplesHelp,
  printJson,
} from '../utils/cli.js';
import type { DeployConfig, DeployResult, DeployStatus, DeployTarget } from '@cogitator-ai/types';

export interface DeployFlags {
  target?: string;
  config?: string;
  registry?: string;
  push: boolean;
  dryRun?: boolean;
  region?: string;
  json?: boolean;
}

function isDeployTarget(value: string, available: readonly string[]): value is DeployTarget {
  return available.includes(value);
}

function resolveTarget(requested: string | undefined, available: readonly string[]): DeployTarget {
  const raw = requested ?? 'docker';
  if (!isDeployTarget(raw, available)) {
    throw new UsageError(`Unsupported deploy target: "${raw}"`, [
      `Available targets: ${available.join(', ')}`,
    ]);
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
    throw new CommandError(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function spin(text: string, flags: DeployFlags) {
  return ora({ text, isSilent: flags.json === true }).start();
}

/** A deploy plan as data: what `--json` prints and what the terminal view shows. */
export function describePlan(plan: DeployPlan, target: DeployTarget, configPath?: string) {
  const { config, preflight } = plan;
  return {
    target,
    ...(configPath && { configPath }),
    config: {
      ...(config.kind && { kind: config.kind }),
      ...(config.server && { server: config.server }),
      ...(config.port && { port: config.port }),
      ...(config.region && { region: config.region }),
      ...(config.registry && { registry: config.registry }),
      ...(config.image && { image: config.image }),
      ...(config.instances && { instances: config.instances }),
    },
    services: {
      redis: Boolean(config.services?.redis),
      postgres: Boolean(config.services?.postgres),
      provisioned: target === 'docker',
    },
    volumes: (config.volumes ?? []).map((volume) => volume.path),
    secrets: config.secrets ?? [],
    warnings: plan.warnings,
    preflight: {
      passed: preflight.passed,
      checks: preflight.checks.map(({ name, passed, message, fix }) => ({
        name,
        passed,
        message,
        ...(fix && { fix }),
      })),
    },
  };
}

export type PlanSummary = ReturnType<typeof describePlan>;

function printPlan(summary: PlanSummary): void {
  const { config, target } = summary;
  console.log();
  log.info(`Deploy plan for ${chalk.bold(target)}`);
  console.log();

  console.log(chalk.dim('  Configuration:'));
  if (summary.configPath) console.log(`    Config:   ${chalk.cyan(summary.configPath)}`);
  console.log(`    Target:   ${chalk.cyan(target)}`);
  if (config.kind) console.log(`    Kind:     ${chalk.cyan(config.kind)}`);
  if (config.server) console.log(`    Server:   ${chalk.cyan(config.server)}`);
  if (config.port) console.log(`    Port:     ${chalk.cyan(String(config.port))}`);
  if (config.region) console.log(`    Region:   ${chalk.cyan(config.region)}`);
  if (config.registry) console.log(`    Registry: ${chalk.cyan(config.registry)}`);
  if (config.image) console.log(`    App:      ${chalk.cyan(config.image)}`);
  if (config.instances) console.log(`    Instances: ${chalk.cyan(String(config.instances))}`);
  console.log();

  if (summary.warnings.length > 0) {
    console.log(chalk.dim('  Warnings:'));
    for (const warning of summary.warnings) console.log(`    ${chalk.yellow('!')} ${warning}`);
    console.log();
  }

  const { services } = summary;
  if (services.redis || services.postgres) {
    const icon = services.provisioned ? chalk.green('●') : chalk.yellow('○');
    const note = (variable: string) =>
      services.provisioned ? '' : chalk.dim(` (not provisioned on ${target}, set ${variable})`);
    console.log(chalk.dim('  Services:'));
    if (services.redis) console.log(`    ${icon} Redis${note('REDIS_URL')}`);
    if (services.postgres) console.log(`    ${icon} PostgreSQL${note('DATABASE_URL')}`);
    console.log();
  }

  if (summary.volumes.length > 0) {
    console.log(chalk.dim('  Volumes:'));
    for (const volume of summary.volumes) console.log(`    ${chalk.green('●')} ${volume}`);
    console.log();
  }

  if (summary.secrets.length > 0) {
    console.log(chalk.dim('  Required secrets:'));
    for (const secret of summary.secrets) console.log(`    ${chalk.yellow('○')} ${secret}`);
    console.log();
  }

  console.log(chalk.dim('  Preflight checks:'));
  for (const check of summary.preflight.checks) {
    const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
    console.log(`    ${icon} ${check.message}`);
  }
  console.log();
}

async function runDeploy(flags: DeployFlags): Promise<void> {
  const projectDir = resolve(process.cwd());

  const deployer = new Deployer();
  const inputs = loadDeployInputs(projectDir, flags);
  const target = resolveTarget(inputs.target, deployer.availableTargets());
  const configOverrides = inputs.overrides;

  const spinner = spin('Analyzing project...', flags);
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
    throw new CommandError(errorMessage(error));
  }
  spinner.stop();

  const summary = describePlan(plan, target, inputs.configPath);
  const passed = summary.preflight.passed;
  if (flags.json && (flags.dryRun || !passed)) {
    printJson({ ok: passed, dryRun: flags.dryRun === true, ...summary });
    if (!passed) process.exitCode = EXIT.failed;
    return;
  }
  if (!flags.json) printPlan(summary);

  if (!passed) {
    throw new CommandError('Preflight checks failed', {
      hints: summary.preflight.checks.flatMap((check) => (check.fix ? [`Fix: ${check.fix}`] : [])),
    });
  }

  if (flags.dryRun) {
    log.success('Dry run completed, no changes made');
    return;
  }

  const deploySpinner = spin('Deploying...', flags);

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
    throw new CommandError(errorMessage(error));
  }

  if (!result.success) {
    deploySpinner.fail('Deploy failed');
    throw new CommandError(result.error ?? 'Unknown error');
  }

  if (flags.json) {
    deploySpinner.stop();
    printJson({
      ok: true,
      dryRun: false,
      ...summary,
      ...(result.url && { url: result.url }),
      ...(result.endpoints && { endpoints: result.endpoints }),
    });
    return;
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
  console.log(`  cogitator deploy status   check deployment status`);
  console.log(`  cogitator deploy destroy  tear down deployment`);
  console.log();
}

async function runDeployStatus(flags: DeployFlags): Promise<void> {
  const projectDir = resolve(process.cwd());
  const deployer = new Deployer();
  const inputs = loadDeployInputs(projectDir, flags);
  const target = resolveTarget(inputs.target, deployer.availableTargets());

  const spinner = spin('Checking deployment status...', flags);

  const deployConfig: DeployConfig = { ...inputs.overrides, target };
  let status: DeployStatus;
  try {
    status = await deployer.status(target, deployConfig, projectDir, {
      configPath: inputs.configPath,
    });
  } catch (error) {
    spinner.fail('Failed to check status');
    throw new CommandError(errorMessage(error));
  }

  spinner.stop();
  if (flags.json) {
    printJson({ ok: true, target, ...status });
    return;
  }
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

  const spinner = spin(`Destroying ${target} deployment...`, flags);

  const deployConfig: DeployConfig = { ...inputs.overrides, target };

  try {
    await deployer.destroy(target, deployConfig, projectDir, { configPath: inputs.configPath });
    spinner.succeed('Deployment destroyed');
    if (flags.json) printJson({ ok: true, target, destroyed: true });
  } catch (err) {
    spinner.fail('Failed to destroy deployment');
    throw new CommandError(errorMessage(err));
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
  .option('--json', 'print the plan, the result or the status as JSON')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator deploy --dry-run', 'check the plan: secrets, services, preflight'],
      ['cogitator deploy --dry-run --json', 'the same plan for scripts and CI'],
      ['cogitator deploy --target fly', 'build and deploy to Fly.io'],
      ['cogitator deploy status', 'is the deployment running?'],
      ['cogitator deploy destroy', 'tear the deployment down'],
    ])
  )
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
        throw new UsageError(`Unknown action: "${action}"`, ['Available actions: status, destroy']);
    }
  });
