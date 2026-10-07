import { code } from './code.js';
import { orderedScripts } from './emit.js';
import { findPreset } from './presets.js';
import type { NextStep, ProjectBuilder } from './project.js';
import { providerInfo } from './providers.js';
import { installCommand, runScript } from './package-manager.js';
import { bareModel, type ProjectSpec } from './spec.js';

export const DOCS_URL = 'https://cogitator.app/docs';
export const REPO_URL = 'https://github.com/cogitator-ai/Cogitator-AI';

/** What is already done when the next steps are shown. */
export interface SetupState {
  /** Where the project is relative to the user's shell; no `cd` step when absent. */
  directory?: string;
  installed: boolean;
  /** Whether the provider key was written to `.env`. */
  keyWritten: boolean;
  /** Whether the Ollama model is known to be pulled. */
  modelReady: boolean;
}

function quoteDirectory(directory: string): string {
  return /^[\w./-]+$/.test(directory) ? directory : JSON.stringify(directory);
}

/** Compose services the project needs while it runs, other than the model server. */
function backingServices(project: ProjectBuilder): string[] {
  return [...project.services.keys()].filter((name) => name !== 'ollama' && name !== 'ollama-pull');
}

/** The commands that take a freshly scaffolded project to its first successful run. */
export function nextSteps(project: ProjectBuilder, state: SetupState): NextStep[] {
  const { spec } = project;
  const pm = spec.packageManager;
  const steps: NextStep[] = [];
  const info = providerInfo(spec.provider);

  if (state.directory) steps.push({ command: `cd ${quoteDirectory(state.directory)}` });
  if (!state.installed) steps.push({ command: installCommand(pm) });
  if (info.envKey && !state.keyWritten) {
    steps.push({ command: 'cp .env.example .env', note: `then set ${info.envKey} in .env` });
  }
  if (spec.provider === 'ollama' && !state.modelReady) {
    steps.push({
      command: `ollama pull ${bareModel(spec)}`,
      note: spec.compose
        ? 'or let `docker compose up -d` pull it into the Ollama container'
        : 'download the model the agents use',
    });
  }
  const services = backingServices(project);
  if (spec.compose && services.length > 0) {
    steps.push({ command: 'docker compose up -d', note: `starts ${services.join(', ')}` });
  }
  steps.push(...project.nextSteps);
  steps.push({ command: runScript(pm, 'dev') });
  return steps;
}

export function emitReadme(project: ProjectBuilder): void {
  const { spec } = project;
  const pm = spec.packageManager;
  const preset = spec.preset ? findPreset(spec.preset) : undefined;
  const steps = nextSteps(project, {
    installed: false,
    keyWritten: false,
    modelReady: false,
  });
  const stepLines = steps.flatMap((step, i) => [
    ...(i > 0 ? [''] : []),
    ...(step.note ? [`# ${step.note}`] : []),
    step.command,
  ]);
  const sections = project.readme.map(
    (section) => `## ${section.title}\n\n${section.body.trim()}\n`
  );

  project.file(
    'README.md',
    code`
      # ${spec.name}

      ${preset ? `${preset.hint.charAt(0).toUpperCase()}${preset.hint.slice(1)}.` : 'An AI agent project.'} Built with [Cogitator](${REPO_URL}).

      ## Getting started

      \`\`\`bash
      ${stepLines.join('\n')}
      \`\`\`

      ## Commands

      | Command | What it does |
      | --- | --- |
      ${Object.keys(orderedScripts(project.scripts))
        .map((script) => `| \`${runScript(pm, script)}\` | ${describeScript(script)} |`)
        .join('\n')}

      ${sections.join('\n')}

      ## Learn more

      - [AGENTS.md](./AGENTS.md): how this project is put together, for you and your coding agent
      - [Cogitator docs](${DOCS_URL})
      - [Cogitator on GitHub](${REPO_URL})
    `
  );
}

const SCRIPT_DESCRIPTIONS: Record<string, string> = {
  dev: 'Run the project and restart on change',
  ask: 'Ask the assistant once: pass the question after the command',
  build: 'Compile the project',
  start: 'Run the compiled project',
  test: 'Offline tests with a mocked model',
  typecheck: 'Type-check without emitting',
  lint: 'Lint and check formatting with Biome',
  format: 'Format and fix lint issues',
  eval: 'Score the assistant on the eval dataset',
  studio: 'Open Cogitator Studio: chat, traces, costs, approvals and run forks',
  doctor: 'Check keys, services and models',
  ingest: 'Index the files in docs/ for RAG',
  'mcp:serve': 'Serve the agents as an MCP server over stdio',
  worker: 'Start the queue worker',
  enqueue: 'Queue a job for the worker',
};

function describeScript(script: string): string {
  return SCRIPT_DESCRIPTIONS[script] ?? 'See package.json';
}

/** Re-creates the project with the same choices: stored in package.json for reference. */
export function reproducibleCommand(spec: ProjectSpec, version: string): string {
  const args = [
    `create-cogitator-app@${version}`,
    spec.name,
    ...(spec.preset ? ['--preset', spec.preset] : []),
    '--app',
    spec.app,
    ...(spec.server ? ['--server', spec.server] : []),
    ...(spec.channels.length > 0 ? ['--channels', spec.channels.join(',')] : []),
    '--memory',
    spec.memory,
    ...(spec.features.includes('rag') ? ['--vector-store', spec.vectorStore] : []),
    ...(spec.features.length > 0 ? ['--features', spec.features.join(',')] : []),
    '--provider',
    spec.provider,
    '--model',
    spec.model,
    '--deploy',
    spec.deploy,
    spec.compose ? '--docker' : '--no-docker',
    ...(spec.codingAgents.length > 0 ? ['--agent', spec.codingAgents.join(',')] : []),
    '--pm',
    spec.packageManager,
    '--yes',
  ];
  return `npx ${args.map((arg) => (/^[\w@./:,=-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ')}`;
}
