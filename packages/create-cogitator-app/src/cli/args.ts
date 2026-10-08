import { parseArgs, type ParseArgsConfig } from 'node:util';
import { presetIds, findPreset } from '../kit/presets.js';
import {
  APP_KINDS,
  CHANNELS,
  CODING_AGENTS,
  DEPLOY_TARGETS,
  FEATURES,
  MEMORIES,
  PACKAGE_MANAGERS,
  PROVIDERS,
  SERVERS,
  VECTOR_STORES,
  type AppKind,
  type ChannelKind,
  type CodingAgent,
  type DeployTarget,
  type FeatureId,
  type LLMProvider,
  type MemoryKind,
  type PackageManager,
  type ServerFramework,
  type VectorStore,
} from '../kit/spec.js';
import type { RemoteTemplate } from '../kit/remote.js';
import { closest } from '../kit/suggest.js';

export { closest };

/** A usage mistake: shown without a stack trace, exits with code 1. */
export class CliError extends Error {
  readonly code = 'INVALID_ARGS';

  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export type { RemoteTemplate };

export interface CliArgs {
  directory?: string;
  preset?: string;
  remote?: RemoteTemplate;
  example?: string;
  app?: AppKind;
  server?: ServerFramework;
  channels?: ChannelKind[];
  memory?: MemoryKind;
  vectorStore?: VectorStore;
  features?: FeatureId[];
  deploy?: DeployTarget;
  compose?: boolean;
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;
  packageManager?: PackageManager;
  codingAgents?: CodingAgent[];
  git?: boolean;
  install?: boolean;
  telemetry?: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  listTemplates: boolean;
  listExamples: boolean;
}

const OPTIONS = {
  preset: { type: 'string', short: 't' },
  template: { type: 'string' },
  example: { type: 'string' },
  app: { type: 'string' },
  server: { type: 'string' },
  channels: { type: 'string', multiple: true },
  memory: { type: 'string' },
  'vector-store': { type: 'string' },
  features: { type: 'string', multiple: true },
  with: { type: 'string', multiple: true },
  deploy: { type: 'string' },
  docker: { type: 'boolean' },
  provider: { type: 'string', short: 'p' },
  model: { type: 'string', short: 'm' },
  'api-key': { type: 'string' },
  pm: { type: 'string' },
  agent: { type: 'string', multiple: true },
  git: { type: 'boolean' },
  install: { type: 'boolean' },
  telemetry: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'list-templates': { type: 'boolean' },
  'list-presets': { type: 'boolean' },
  'list-examples': { type: 'boolean' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

const OPTION_NAMES = Object.keys(OPTIONS);

function suggestion(input: string, candidates: readonly string[]): string {
  const match = closest(input, candidates);
  return match ? ` Did you mean "${match}"?` : '';
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found) return found;
  throw new CliError(
    `Invalid --${flag} "${value}".${suggestion(value, allowed)} Use one of: ${allowed.join(', ')}.`
  );
}

/** Values of a list option, given repeated (`--x a --x b`) or comma separated (`--x a,b`). */
function listOf<T extends string>(
  flag: string,
  values: readonly string[],
  allowed: readonly T[]
): T[] {
  const items = values
    .flatMap((value) => value.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items.map((item) => oneOf(flag, item, allowed)))];
}

/** Parses `github:owner/repo`, `github:owner/repo/sub/dir` and an optional `#ref`. */
export function parseRemoteTemplate(value: string): RemoteTemplate {
  const match =
    /^(?:github:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/((?:[\w.-]+\/)*[\w.-]+)\/?)?(?:#([^\s~^:?*[\\]+))?$/.exec(
      value
    );
  if (!match) {
    throw new CliError(
      `Invalid remote template "${value}". Use github:owner/repo, github:owner/repo/path or github:owner/repo#ref.`
    );
  }
  const [, owner, repo, path, ref] = match;
  return {
    owner,
    repo,
    ...(path && { path: path.replace(/\/$/, '') }),
    ...(ref && { ref }),
  };
}

function isRemote(value: string): boolean {
  return value.startsWith('github:') || value.startsWith('https://github.com/');
}

/**
 * Parses the command line. Unknown options and invalid values are errors,
 * also with `--yes`: a typo never silently becomes a default.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unknown = /Unknown option '(--?[\w-]+)'/.exec(message)?.[1];
    if (unknown) {
      const name = unknown.replace(/^--?/, '');
      const hint = closest(name, OPTION_NAMES);
      throw new CliError(
        `Unknown option ${unknown}.${hint ? ` Did you mean --${hint}?` : ''} Run with --help for the options.`
      );
    }
    throw new CliError(`${message.replace(/\.$/, '')}. Run with --help for the options.`);
  }

  const { values, positionals } = parsed;
  if (positionals.length > 1) {
    throw new CliError(
      `Expected one project directory, got ${positionals.length}: ${positionals.join(' ')}. Quote a path with spaces.`
    );
  }

  const presetValue = values.preset ?? values.template;
  if (
    values.preset !== undefined &&
    values.template !== undefined &&
    values.preset !== values.template
  ) {
    throw new CliError('--preset and --template name different presets, pass only one of them.');
  }

  let preset: string | undefined;
  let remote: RemoteTemplate | undefined;
  if (presetValue !== undefined) {
    if (isRemote(presetValue)) {
      remote = parseRemoteTemplate(presetValue);
    } else {
      const found = findPreset(presetValue);
      if (!found) {
        throw new CliError(
          `Unknown preset "${presetValue}".${suggestion(presetValue, presetIds())} Run with --list-templates to see them all.`
        );
      }
      preset = found.id;
    }
  }
  if (remote && values.example !== undefined) {
    throw new CliError('--example and a remote --template cannot be combined.');
  }
  if (values.example !== undefined && preset) {
    throw new CliError('--example replaces the preset, pass only one of --example and --preset.');
  }

  const features = [...(values.features ?? []), ...(values.with ?? [])];
  const apiKey = values['api-key'];
  if (apiKey !== undefined && !apiKey.trim()) throw new CliError('--api-key is empty.');
  const model = values.model?.trim();
  if (values.model !== undefined && !model) throw new CliError('--model is empty.');

  return {
    ...(positionals[0] !== undefined && { directory: positionals[0] }),
    ...(preset && { preset }),
    ...(remote && { remote }),
    ...(values.example !== undefined && { example: values.example }),
    ...(values.app !== undefined && { app: oneOf('app', values.app, APP_KINDS) }),
    ...(values.server !== undefined && { server: oneOf('server', values.server, SERVERS) }),
    ...(values.channels && { channels: listOf('channels', values.channels, CHANNELS) }),
    ...(values.memory !== undefined && { memory: oneOf('memory', values.memory, MEMORIES) }),
    ...(values['vector-store'] !== undefined && {
      vectorStore: oneOf('vector-store', values['vector-store'], VECTOR_STORES),
    }),
    ...(features.length > 0 && { features: listOf('features', features, FEATURES) }),
    ...(values.deploy !== undefined && { deploy: oneOf('deploy', values.deploy, DEPLOY_TARGETS) }),
    ...(values.docker !== undefined && { compose: values.docker }),
    ...(values.provider !== undefined && {
      provider: oneOf('provider', values.provider, PROVIDERS),
    }),
    ...(model && { model }),
    ...(apiKey !== undefined && { apiKey: apiKey.trim() }),
    ...(values.pm !== undefined && { packageManager: oneOf('pm', values.pm, PACKAGE_MANAGERS) }),
    ...(values.agent && {
      codingAgents: listOf(
        'agent',
        values.agent.filter((a) => a !== 'none'),
        CODING_AGENTS
      ),
    }),
    ...(values.git !== undefined && { git: values.git }),
    ...(values.install !== undefined && { install: values.install }),
    ...(values.telemetry !== undefined && { telemetry: values.telemetry }),
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
    json: values.json ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    listTemplates: (values['list-templates'] ?? false) || (values['list-presets'] ?? false),
    listExamples: values['list-examples'] ?? false,
  };
}

/**
 * Whether to ask questions: only at a terminal, and never with `--yes`,
 * `--json` or in CI, where nobody can answer.
 */
export function isInteractive(
  args: Pick<CliArgs, 'yes' | 'json'>,
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin
): boolean {
  if (args.yes || args.json) return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  return stdin.isTTY === true;
}
