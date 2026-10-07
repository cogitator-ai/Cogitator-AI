import pc from 'picocolors';
import {
  APP_CHOICES,
  CHANNEL_CHOICES,
  CODING_AGENT_CHOICES,
  DEPLOY_CHOICES,
  FEATURE_CHOICES,
  MEMORY_CHOICES,
  SERVER_CHOICES,
  VECTOR_STORE_CHOICES,
  type Choice,
} from '../kit/catalog.js';
import { DEFAULT_PRESET, PRESETS } from '../kit/presets.js';
import { PACKAGE_MANAGERS, PROVIDERS } from '../kit/spec.js';

function values(choices: readonly Choice<string>[]): string {
  return choices.map((choice) => choice.value).join(', ');
}

function row(flag: string, description: string): string {
  return `  ${pc.cyan(flag.padEnd(28))} ${description}`;
}

export function helpText(version: string): string {
  return [
    `${pc.bold('create-cogitator-app')} ${pc.dim(`v${version}`)}`,
    '',
    'Create a Cogitator AI agent project.',
    '',
    `${pc.bold('Usage')}`,
    '  npx create-cogitator-app [directory] [options]',
    '',
    `${pc.bold('Stack')}`,
    row(
      '-t, --preset <name>',
      `a named starting point (default ${DEFAULT_PRESET}), see --list-templates`
    ),
    row(
      '    --template <name|repo>',
      'a preset, or github:owner/repo[/path][#ref] to copy a repository'
    ),
    row('    --example <name>', 'start from an example of the Cogitator repository'),
    row('    --app <kind>', values(APP_CHOICES)),
    row('    --server <framework>', values(SERVER_CHOICES)),
    row('    --channels <list>', values(CHANNEL_CHOICES)),
    row('    --memory <kind>', values(MEMORY_CHOICES)),
    row('    --vector-store <store>', `for RAG: ${values(VECTOR_STORE_CHOICES)}`),
    row('    --features <list>', `added to the preset's: ${values(FEATURE_CHOICES)}`),
    row('    --deploy <target>', values(DEPLOY_CHOICES)),
    row('    --[no-]docker', 'write docker-compose.yml for local services (default yes)'),
    '',
    `${pc.bold('Model')}`,
    row('-p, --provider <name>', PROVIDERS.join(', ')),
    row(
      '-m, --model <id>',
      "the model id at the provider, e.g. gpt-6.1-sol, default: the provider's"
    ),
    row('    --api-key <key>', 'written to .env (mode 600) and never printed'),
    '',
    `${pc.bold('Tooling')}`,
    row('    --pm <name>', `${PACKAGE_MANAGERS.join(', ')} (default: the one running this)`),
    row('    --agent <list>', `coding agent setup: ${values(CODING_AGENT_CHOICES)}, none`),
    row('    --[no-]git', 'create a git repository with the first commit (default yes)'),
    row('    --[no-]install', 'install dependencies (default yes)'),
    row('    --no-telemetry', 'send no anonymous usage event, see the docs'),
    '',
    `${pc.bold('Output')}`,
    row('-y, --yes', 'ask nothing, use defaults for whatever the flags leave out'),
    row('    --dry-run', 'show the files and dependencies without writing anything'),
    row('    --json', 'print the result as JSON, implies --yes'),
    row('    --list-templates', 'list the presets'),
    row('-h, --help', 'show this help'),
    row('-v, --version', 'show the version'),
    '',
    `${pc.bold('Examples')}`,
    '  npx create-cogitator-app my-bot --preset channels --channels telegram',
    '  npx create-cogitator-app api --app server --server fastify --memory postgres --features rag,evals',
    '  npx create-cogitator-app . --provider anthropic --api-key "$ANTHROPIC_API_KEY" --yes',
    '  npx create-cogitator-app demo --preset nextjs --dry-run --json',
    '',
    'Without a TTY or with CI set, nothing is asked: flags and defaults decide everything.',
    '',
  ].join('\n');
}

export function presetList(): string {
  const width = Math.max(...PRESETS.map((preset) => preset.id.length));
  return (
    PRESETS.map(
      (preset) => `  ${pc.cyan(preset.id.padEnd(width))}  ${preset.label}: ${pc.dim(preset.hint)}`
    ).join('\n') + '\n'
  );
}
