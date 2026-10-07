import { basename, resolve } from 'node:path';
import { DEFAULT_PRESET, findPreset } from '../kit/presets.js';
import { defaultModel } from '../kit/providers.js';
import { validateProjectName, type ProjectSpecInput, type PackageManager } from '../kit/spec.js';
import { CliError, type CliArgs } from './args.js';

export const DEFAULT_DIRECTORY = 'my-agents';

/** The package name for a project created in `directory`: its last path segment, so `.` takes the current directory's name. */
export function projectNameFromDirectory(directory: string, cwd: string = process.cwd()): string {
  return basename(resolve(cwd, directory.trim()));
}

export function resolveDirectory(
  directory: string,
  cwd: string = process.cwd()
): { path: string; name: string } {
  const name = projectNameFromDirectory(directory, cwd);
  const error = validateProjectName(name);
  if (error) throw new CliError(`Invalid project name "${name}": ${error}`);
  return { path: resolve(cwd, directory.trim()), name };
}

/**
 * The spec the flags describe, on top of the preset they name (or the default
 * one). Flags win over the preset, and `--features` adds to the preset's
 * features instead of replacing them.
 */
export function specFromArgs(
  args: CliArgs,
  context: { name: string; packageManager: PackageManager }
): ProjectSpecInput {
  const custom = args.app !== undefined && args.preset === undefined;
  const preset = custom ? undefined : findPreset(args.preset ?? DEFAULT_PRESET);
  if (!custom && !preset) throw new CliError(`Unknown preset "${args.preset}"`);

  const base = preset?.spec;
  const app = args.app ?? base?.app ?? 'script';
  const provider = args.provider ?? base?.provider ?? 'ollama';
  const server =
    args.server ?? (app === 'server' ? (base?.app === 'server' ? base.server : 'hono') : undefined);
  const channels = args.channels ?? (app === 'channels' ? (base?.channels ?? ['webchat']) : []);
  const features = [...new Set([...(base?.features ?? []), ...(args.features ?? [])])];

  return {
    name: context.name,
    ...(preset && { preset: preset.id }),
    app,
    ...(server && { server }),
    channels,
    memory: args.memory ?? base?.memory ?? 'none',
    vectorStore: args.vectorStore ?? base?.vectorStore ?? 'memory',
    features,
    provider,
    model: args.model ?? defaultModel(provider),
    deploy: args.deploy ?? 'none',
    compose: args.compose ?? true,
    packageManager: args.packageManager ?? (server === 'tetsu' ? 'bun' : context.packageManager),
    codingAgents: args.codingAgents ?? [],
  };
}
