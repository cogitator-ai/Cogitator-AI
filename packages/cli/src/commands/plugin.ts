/**
 * cogitator plugin - install, update and manage plugins and their marketplaces, in the formats of
 * Claude Code's plugins, and run their eval suites
 */

import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { password, isCancel } from '@clack/prompts';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import {
  experimental_PluginInstaller,
  experimental_validatePlugin,
  loadPluginSettings,
  readPluginLayout,
  type PluginInstallQuestion,
  type PluginInstallerOptions,
} from '@cogitator-ai/core';
import type { PluginOptionValue } from '@cogitator-ai/types';
import { CommandError, examplesHelp, printJson, reportFailure, UsageError } from '../utils/cli.js';
import { pluginEvalCommand } from './plugin-eval.js';

/** How the plugin commands talk to the person running them */
export interface PluginIo {
  print(line: string): void;
  /** Asks a yes or no question, undefined when nobody can answer (not a terminal) */
  confirm(question: string): Promise<boolean | undefined>;
  /** Reads a secret without showing it, undefined when nobody can answer */
  secret(question: string): Promise<string | undefined>;
}

/** What the commands are built with: the installer's options and how to talk */
export interface PluginCommandContext {
  io: PluginIo;
  installer: (options: PluginInstallerOptions) => experimental_PluginInstaller;
  cwd: string;
  /** Directories of the user's settings (default `~/.cogitator`, `~/.claude`) */
  userDirs?: readonly string[];
}

/** Talks on the terminal: prompts only when stdin is one */
export function terminalPluginIo(): PluginIo {
  return {
    print: (line) => console.log(line),
    confirm: async (question) => {
      if (!process.stdin.isTTY) return undefined;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await prompt.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
    secret: async (question) => {
      if (!process.stdin.isTTY) return undefined;
      const answer = await password({ message: question });
      return isCancel(answer) ? undefined : answer;
    },
  };
}

const defaultContext = (): PluginCommandContext => ({
  io: terminalPluginIo(),
  installer: (options) => new experimental_PluginInstaller(options),
  cwd: process.cwd(),
});

type Scope = 'user' | 'project' | 'local';

function parseScope(value: string): Scope {
  if (value === 'user' || value === 'project' || value === 'local') return value;
  throw new InvalidArgumentError('Expected user, project or local.');
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** `key=value` pairs as option values: `true`, `false` and numbers read as such */
export function parseOptionPairs(pairs: readonly string[]): Record<string, PluginOptionValue> {
  const values: Record<string, PluginOptionValue> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`--config takes key=value, got ${pair}`);
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    values[key] =
      raw === 'true'
        ? true
        : raw === 'false'
          ? false
          : raw.trim() !== '' && !Number.isNaN(Number(raw))
            ? Number(raw)
            : raw;
  }
  return values;
}

/** Answers what an install asks: `yes` agrees to all, otherwise the person is asked */
function confirmer(
  io: PluginIo,
  yes: boolean
): (question: PluginInstallQuestion) => Promise<boolean> {
  return async (question) => {
    if (question.kind === 'permissions') {
      io.print(chalk.bold(`${question.plugin} asks for these permissions:`));
      for (const rule of question.allow) io.print(`  allow ${rule}`);
      for (const rule of question.deny) io.print(chalk.dim(`  deny  ${rule}`));
      if (yes) return true;
      const answer = await io.confirm(
        question.update ? 'Grant the new permissions?' : 'Grant them and install?'
      );
      if (answer === undefined) {
        throw new CommandError('The permissions need an answer and this is not a terminal', {
          hints: ['Pass --yes to grant them'],
        });
      }
      return answer;
    }
    io.print(
      chalk.bold(`${question.plugin} is installed by running this command on your machine:`)
    );
    io.print(`  ${question.command}`);
    io.print(chalk.dim(`  sha256 ${question.sha256}`));
    if (yes) return true;
    const answer = await io.confirm('Run this command now?');
    if (answer === undefined) {
      throw new CommandError('The command was only displayed: this is not a terminal', {
        hints: ['Pass --yes to run it'],
      });
    }
    return answer;
  };
}

async function readSecrets(io: PluginIo, keys: readonly string[]): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  for (const key of keys) {
    const value = await io.secret(`Value of the secret option ${key}`);
    if (value === undefined) {
      throw new CommandError(`The secret ${key} is read from the terminal, and this is not one`, {
        hints: [
          'Run the command in a terminal, so the secret never reaches the command line or the shell history',
        ],
      });
    }
    secrets[key] = value;
  }
  return secrets;
}

interface CommonFlags {
  json?: boolean;
  yes?: boolean;
}

function installerOf(
  context: PluginCommandContext,
  flags: CommonFlags
): experimental_PluginInstaller {
  return context.installer({
    projectRoot: context.cwd,
    settings: { root: context.cwd, ...(context.userDirs && { userDirs: context.userDirs }) },
    ...(context.userDirs && { userDirs: context.userDirs }),
    confirm: confirmer(context.io, flags.yes === true),
    ...(!flags.json && { onProgress: (message: string) => context.io.print(chalk.dim(message)) }),
  });
}

/** Runs `work` and prints its result: a line, or with `--json` one object with `outcome` */
async function respond(
  command: string,
  flags: CommonFlags,
  context: PluginCommandContext,
  work: () => Promise<{ message: string; details?: Record<string, unknown>; lines?: string[] }>
): Promise<number> {
  try {
    const result = await work();
    if (flags.json) {
      printJson({ command, outcome: 'ok', message: result.message, ...result.details });
    } else {
      for (const line of result.lines ?? []) context.io.print(line);
      context.io.print(`${chalk.green('✓')} ${result.message}`);
    }
    return 0;
  } catch (error) {
    if (flags.json) {
      const code = (error as { code?: unknown }).code;
      printJson({
        command,
        outcome: 'failed',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof code === 'string' && { failureCode: code }),
      });
      return 1;
    }
    return reportFailure(error, { json: false });
  }
}

/** `cogitator plugin install` */
export async function runInstall(
  spec: string,
  flags: CommonFlags & {
    scope?: Scope;
    config?: string[];
    secret?: string[];
    marketplace?: string;
  },
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  return respond('install', flags, context, async () => {
    const installer = installerOf(context, flags);
    let target = spec;
    if (flags.marketplace) {
      const added = await installer.addMarketplace(flags.marketplace);
      target = spec.includes('@') ? spec : `${spec}@${added.marketplace.name}`;
    }
    const secrets = await readSecrets(context.io, flags.secret ?? []);
    const result = await installer.install(target, {
      scope: flags.scope ?? 'user',
      yes: flags.yes === true,
      options: parseOptionPairs(flags.config ?? []),
      secrets,
    });
    const message = result.alreadyInstalled
      ? `Plugin "${result.id}" is already installed (scope: ${flags.scope ?? 'user'})`
      : `Successfully installed plugin: ${result.id} ${result.version} (scope: ${flags.scope ?? 'user'})`;
    return {
      message,
      lines: [
        ...result.installed
          .slice(1)
          .map((record) => chalk.dim(`  + dependency ${record.id} ${record.version}`)),
        ...result.notes.map((note) => chalk.yellow(`  ${note}`)),
      ],
      details: {
        pluginId: result.id,
        version: result.version,
        installPath: result.installPath,
        scope: flags.scope ?? 'user',
        alreadyInstalled: result.alreadyInstalled,
        dependencies: result.installed.slice(1).map((record) => record.id),
        notes: result.notes,
      },
    };
  });
}

/** `cogitator plugin uninstall` */
export async function runUninstall(
  spec: string,
  flags: CommonFlags & { keepData?: boolean; prune?: boolean },
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  return respond('uninstall', flags, context, async () => {
    if (flags.prune && !flags.yes) {
      const answer = await context.io.confirm('Also remove the dependencies nothing else needs?');
      if (answer !== true)
        throw new CommandError('Aborted', {
          hints: ['Pass --yes with --prune when not in a terminal'],
        });
    }
    const result = await installerOf(context, flags).uninstall(spec, {
      ...(flags.keepData !== undefined && { keepData: flags.keepData }),
      ...(flags.prune !== undefined && { prune: flags.prune }),
    });
    return {
      message: `Successfully uninstalled plugin: ${result.removed.join(', ')}`,
      details: { removed: result.removed, keptData: result.keptData },
    };
  });
}

/** `cogitator plugin enable` and `disable` */
export async function runSetEnabled(
  spec: string,
  enabled: boolean,
  flags: CommonFlags & { scope?: Scope },
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  return respond(enabled ? 'enable' : 'disable', flags, context, async () => {
    const { file } = await installerOf(context, flags).setEnabled(
      spec,
      enabled,
      flags.scope ?? 'user'
    );
    return {
      message: `Successfully ${enabled ? 'enabled' : 'disabled'} plugin: ${spec} (scope: ${flags.scope ?? 'user'})`,
      details: { pluginId: spec, scope: flags.scope ?? 'user', file },
    };
  });
}

/** `cogitator plugin update` */
export async function runUpdate(
  spec: string | undefined,
  flags: CommonFlags,
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  return respond('update', flags, context, async () => {
    const results = await installerOf(context, flags).update(spec, { yes: flags.yes === true });
    const updated = results.filter((result) => result.updated);
    return {
      message:
        results.length === 1 && !updated.length
          ? (results[0]?.notes.at(-1) ?? 'Nothing to update')
          : `Updated ${updated.length} of ${results.length} plugins`,
      lines: results.flatMap((result) => [
        ...(result.updated ? [`  ${result.id} ${result.from} -> ${result.to}`] : []),
        ...result.notes
          .filter((note) => !note.includes('already at the latest'))
          .map((note) => chalk.yellow(`  ${note}`)),
      ]),
      details: { results },
    };
  });
}

/** `cogitator plugin list`: the install records, what the settings enable, what is wrong with each */
export async function runList(
  flags: CommonFlags & { available?: boolean },
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  try {
    const installer = installerOf(context, flags);
    const records = await installer.list();
    const settings = await loadPluginSettings(context.cwd, {
      root: context.cwd,
      trusted: true,
      ...(context.userDirs && { userDirs: context.userDirs }),
    });
    const rows = [];
    for (const record of records) {
      const layout = await readPluginLayout(record.installPath, {
        ...(record.entry && { entry: record.entry }),
        fallbackName: record.name,
        id: record.id,
      }).catch((error: unknown) => error);
      const errors =
        layout instanceof Error
          ? [layout.message]
          : (layout as Awaited<ReturnType<typeof readPluginLayout>>).diagnostics
              .filter((entry) => entry.level === 'error')
              .map((entry) => entry.message);
      const manifest =
        layout instanceof Error
          ? undefined
          : (layout as Awaited<ReturnType<typeof readPluginLayout>>).manifest;
      const entry = settings.enabled.get(record.id);
      rows.push({
        id: record.id,
        version: record.version,
        enabled: entry?.value ?? (record.dependency === true || manifest?.defaultEnabled !== false),
        ...(entry && { enabledBy: entry.layer }),
        installPath: record.installPath,
        installedAt: record.installedAt,
        lastUpdated: record.lastUpdated,
        ...(record.dependency && { dependency: true }),
        ...(errors.length > 0 && { errors }),
        ...(manifest?.userConfig && { hasUserConfig: true }),
      });
    }
    const available: Record<string, unknown>[] = [];
    if (flags.available) {
      for (const marketplace of await installer.listMarketplaces()) {
        if (marketplace.declared !== undefined) continue;
        const read = await installer.readMarketplace(marketplace.name).catch(() => undefined);
        for (const entry of read?.manifest.plugins ?? []) {
          const pluginId = `${entry.name}@${marketplace.name}`;
          if (records.some((record) => record.id === pluginId)) continue;
          available.push({
            pluginId,
            name: entry.name,
            marketplaceName: marketplace.name,
            source: entry.source,
            ...(entry.description !== undefined && { description: entry.description }),
            ...(entry.version !== undefined && { version: entry.version }),
          });
        }
      }
    }
    if (flags.json) {
      printJson(flags.available ? { installed: rows, available } : rows);
      return 0;
    }
    if (rows.length === 0) {
      context.io.print('No plugins installed. Use `cogitator plugin install` to install a plugin.');
      return 0;
    }
    context.io.print(chalk.bold('Installed plugins:'));
    for (const row of rows) {
      const state = row.errors
        ? chalk.red('failed to load')
        : row.enabled
          ? chalk.green('enabled')
          : chalk.dim('disabled');
      context.io.print(
        `  ${row.id} ${chalk.dim(row.version)} ${state}${row.dependency ? chalk.dim(' (dependency)') : ''}`
      );
      for (const error of row.errors ?? []) context.io.print(chalk.red(`    ${error}`));
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json === true });
  }
}

/** `cogitator plugin configure` */
export async function runConfigure(
  spec: string,
  flags: CommonFlags & { set?: string[]; secret?: string[]; unset?: string[] },
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  return respond('configure', flags, context, async () => {
    const secrets = await readSecrets(context.io, flags.secret ?? []);
    const notes = await installerOf(context, flags).configure(spec, {
      options: parseOptionPairs(flags.set ?? []),
      secrets,
      ...(flags.unset && { unset: flags.unset }),
    });
    return {
      message: `Saved the options of ${spec}`,
      lines: notes.map((note) => chalk.yellow(`  ${note}`)),
      details: { pluginId: spec, notes },
    };
  });
}

/** `cogitator plugin validate`: 0 passed, 1 failed, 2 when the validator itself failed */
export async function runValidate(
  path: string,
  flags: { strict?: boolean; json?: boolean },
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  let result;
  try {
    result = await experimental_validatePlugin(resolve(context.cwd, path), {
      strict: flags.strict === true,
    });
  } catch (error) {
    console.error(
      `Unexpected error during validation: ${error instanceof Error ? error.message : String(error)}`
    );
    return 2;
  }
  if (flags.json) {
    printJson({
      success: result.ok,
      strict: result.strict,
      target: result.target,
      manifest: result.manifest ?? null,
      errors: result.errors,
      warnings: result.warnings,
    });
    return result.ok ? 0 : 1;
  }
  context.io.print(`Validating ${result.target}`);
  for (const error of result.errors)
    context.io.print(
      chalk.red(`  error   ${error.message}${error.path ? chalk.dim(` (${error.path})`) : ''}`)
    );
  for (const warning of result.warnings) {
    context.io.print(
      chalk.yellow(
        `  warning ${warning.message}${warning.path ? chalk.dim(` (${warning.path})`) : ''}`
      )
    );
  }
  const verdict = result.ok
    ? result.warnings.length > 0
      ? 'Validation passed with warnings'
      : 'Validation passed'
    : result.strict && result.errors.length === 0
      ? 'Validation failed (--strict treats warnings as errors)'
      : 'Validation failed';
  context.io.print(result.ok ? chalk.green(verdict) : chalk.red(verdict));
  return result.ok ? 0 : 1;
}

/** `cogitator plugin marketplace add|list|remove|update` */
export async function runMarketplace(
  action: 'add' | 'list' | 'remove' | 'update',
  argument: string | undefined,
  flags: CommonFlags,
  context: PluginCommandContext = defaultContext()
): Promise<number> {
  const installer = installerOf(context, flags);
  if (action === 'list') {
    try {
      const marketplaces = await installer.listMarketplaces();
      if (flags.json) {
        printJson(
          marketplaces.map((entry) => ({
            name: entry.name,
            source: entry.source.source,
            ...('repo' in entry.source && { repo: entry.source.repo }),
            ...('url' in entry.source && { url: entry.source.url }),
            ...('path' in entry.source &&
              entry.source.source !== 'github' &&
              entry.source.source !== 'git' && { path: entry.source.path }),
            ...('ref' in entry.source &&
              entry.source.ref !== undefined && { ref: entry.source.ref }),
            installLocation: entry.installLocation,
            ...(entry.declared !== undefined && { declaredIn: entry.declared }),
          }))
        );
        return 0;
      }
      if (marketplaces.length === 0) {
        context.io.print('No marketplaces configured');
        return 0;
      }
      context.io.print(chalk.bold('Configured marketplaces:'));
      for (const entry of marketplaces) {
        context.io.print(
          `  ${entry.name}${entry.declared !== undefined ? chalk.dim(' (declared in settings, not fetched yet)') : ''}`
        );
        context.io.print(chalk.dim(`    Source: ${JSON.stringify(entry.source)}`));
      }
      return 0;
    } catch (error) {
      return reportFailure(error, { json: flags.json === true });
    }
  }
  return respond(`marketplace-${action}`, flags, context, async () => {
    if (action === 'add') {
      if (!argument)
        throw new UsageError('marketplace add needs a source: owner/repo, https://..., or ./path');
      const { marketplace, read, alreadyAdded } = await installer.addMarketplace(argument);
      return {
        message: alreadyAdded
          ? `Marketplace '${marketplace.name}' already added, fetched again`
          : `Successfully added marketplace: ${marketplace.name}`,
        lines: read.diagnostics.map((entry) =>
          entry.level === 'error'
            ? chalk.red(`  ${entry.message}`)
            : chalk.yellow(`  ${entry.message}`)
        ),
        details: {
          marketplace: marketplace.name,
          plugins: read.manifest.plugins.map((entry) => entry.name),
        },
      };
    }
    if (action === 'remove') {
      if (!argument) throw new UsageError('marketplace remove needs the marketplace name');
      const { uninstalled } = await installer.removeMarketplace(argument);
      return {
        message: `Successfully removed marketplace: ${argument}`,
        lines:
          uninstalled.length > 0
            ? [
                `Also uninstalled ${uninstalled.length} plugins from this marketplace:`,
                ...uninstalled.map((id) => `  ${id}`),
              ]
            : [],
        details: { marketplace: argument, uninstalled },
      };
    }
    const updated = await installer.updateMarketplace(argument);
    return {
      message: argument
        ? `Successfully updated marketplace: ${argument}`
        : `Successfully updated ${updated.length} marketplaces`,
      details: { marketplaces: updated.map((entry) => entry.name) },
    };
  });
}

const json = ['--json', 'print the result as one JSON object'] as const;

const install = new Command('install')
  .alias('i')
  .description(
    'Install a plugin from a marketplace (name@marketplace), npm (npm:<package>) or git (git+<url>, github:<owner>/<repo>)'
  )
  .argument(
    '<plugin>',
    'name@marketplace, name, npm:<package>[@version], github:<owner>/<repo>[#ref] or git+<url>[#ref]'
  )
  .option(
    '-s, --scope <scope>',
    'the settings file that enables it: user, project or local',
    parseScope,
    'user'
  )
  .option('--config <key=value>', 'set an option the plugin declares, repeat for several', collect)
  .option(
    '--secret <key>',
    'set a sensitive option, read from the terminal, repeat for several',
    collect
  )
  .option('--marketplace <source>', 'add this marketplace first and install the plugin from it')
  .option(
    '-y, --yes',
    'grant the permissions the plugin asks for and run a command source without asking'
  )
  .option(...json)
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator plugin install formatter@team-tools', 'from an added marketplace'],
      [
        'cogitator plugin install npm:@acme/review-kit@^2.0.0',
        'straight from npm, pinned to the version found',
      ],
      ['cogitator plugin install git+https://git.example.com/tools.git#v1.2.0', 'from a git tag'],
    ])
  )
  .action(async (spec: string, flags: Parameters<typeof runInstall>[1]) => {
    process.exitCode = await runInstall(spec, flags);
  });

const uninstall = new Command('uninstall')
  .aliases(['remove', 'rm'])
  .description('Remove an installed plugin, its files, options, secrets and data')
  .argument('<plugin>', 'name@marketplace')
  .option('--keep-data', 'keep its data folder')
  .option('--prune', 'also remove the dependencies nothing else needs')
  .option('-y, --yes', 'do not ask before pruning')
  .option(...json)
  .action(async (spec: string, flags: Parameters<typeof runUninstall>[1]) => {
    process.exitCode = await runUninstall(spec, flags);
  });

const enable = new Command('enable')
  .description('Enable an installed plugin')
  .argument('<plugin>', 'name@marketplace')
  .option('-s, --scope <scope>', 'user, project or local', parseScope, 'user')
  .option(...json)
  .action(async (spec: string, flags: Parameters<typeof runSetEnabled>[2]) => {
    process.exitCode = await runSetEnabled(spec, true, flags);
  });

const disable = new Command('disable')
  .description('Disable an installed plugin without removing it')
  .argument('<plugin>', 'name@marketplace')
  .option('-s, --scope <scope>', 'user, project or local', parseScope, 'user')
  .option(...json)
  .action(async (spec: string, flags: Parameters<typeof runSetEnabled>[2]) => {
    process.exitCode = await runSetEnabled(spec, false, flags);
  });

const update = new Command('update')
  .description(
    'Fetch an installed plugin (every one without a name) again and install its new version'
  )
  .argument('[plugin]', 'name@marketplace')
  .option('-y, --yes', 'grant new permissions without asking')
  .option(...json)
  .action(async (spec: string | undefined, flags: CommonFlags) => {
    process.exitCode = await runUpdate(spec, flags);
  });

const list = new Command('list')
  .description('List the installed plugins with their version and status')
  .option('--available', 'with --json, also the plugins the marketplaces offer')
  .option(...json)
  .action(async (flags: Parameters<typeof runList>[0]) => {
    process.exitCode = await runList(flags);
  });

const configure = new Command('configure')
  .description(
    "Set the options a plugin declares (its userConfig): secrets go to the system's credential store"
  )
  .argument('<plugin>', 'name@marketplace')
  .option('--set <key=value>', 'an option that is not a secret, repeat for several', collect)
  .option(
    '--secret <key>',
    'a sensitive option, read from the terminal, repeat for several',
    collect
  )
  .option('--unset <key>', 'clear an option, repeat for several', collect)
  .option(...json)
  .action(async (spec: string, flags: Parameters<typeof runConfigure>[1]) => {
    process.exitCode = await runConfigure(spec, flags);
  });

const validate = new Command('validate')
  .description(
    'Check a plugin folder as claude plugin validate does: 0 passed, 1 failed, 2 when the check itself failed'
  )
  .argument('<path>', 'the plugin folder')
  .option('--strict', 'treat warnings as errors')
  .option(...json)
  .action(async (path: string, flags: { strict?: boolean; json?: boolean }) => {
    process.exitCode = await runValidate(path, flags);
  });

const marketplace = new Command('marketplace').description(
  'Add, list, update and remove plugin marketplaces'
);
marketplace
  .command('add')
  .description(
    'Add a marketplace: owner/repo, a git URL, an https link to a marketplace.json, or a local folder or file'
  )
  .argument('<source>', 'where the marketplace is')
  .option(...json)
  .action(async (source: string, flags: CommonFlags) => {
    process.exitCode = await runMarketplace('add', source, flags);
  });
marketplace
  .command('list')
  .description('List the marketplaces added and the ones settings declare')
  .option(...json)
  .action(async (flags: CommonFlags) => {
    process.exitCode = await runMarketplace('list', undefined, flags);
  });
marketplace
  .command('remove')
  .alias('rm')
  .description('Remove a marketplace and every plugin installed from it')
  .argument('<name>', 'the marketplace name')
  .option(...json)
  .action(async (name: string, flags: CommonFlags) => {
    process.exitCode = await runMarketplace('remove', name, flags);
  });
marketplace
  .command('update')
  .description('Fetch a marketplace (every one without a name) again')
  .argument('[name]', 'the marketplace name')
  .option(...json)
  .action(async (name: string | undefined, flags: CommonFlags) => {
    process.exitCode = await runMarketplace('update', name, flags);
  });

export const pluginCommand = new Command('plugin')
  .alias('plugins')
  .description('Install and manage plugins (Claude Code plugin format) and run their evals')
  .addCommand(install)
  .addCommand(uninstall)
  .addCommand(enable)
  .addCommand(disable)
  .addCommand(update)
  .addCommand(list)
  .addCommand(configure)
  .addCommand(validate)
  .addCommand(marketplace)
  .addCommand(pluginEvalCommand)
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator plugin marketplace add your-org/plugins', 'add a marketplace from GitHub'],
      ['cogitator plugin install review@your-org', 'install a plugin from it'],
      ['cogitator plugin validate ./my-plugin --strict', 'check a plugin before publishing'],
      ['cogitator plugin eval ./my-plugin', 'score its eval suite with and without it'],
    ])
  );
