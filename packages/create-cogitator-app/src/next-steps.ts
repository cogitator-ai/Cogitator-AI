import type { ProjectOptions } from './types.js';
import { devCommand } from './utils/package-manager.js';
import { modelFor, providerEnvKey } from './utils/providers.js';

/** A command to run before the first start, with an optional explanation. */
export interface NextStep {
  command: string;
  note?: string;
}

export interface NextStepsState {
  /** Whether `<pm> install` already ran. */
  installed: boolean;
  /** Whether the Ollama model is known to be pulled; ignored for other providers. */
  modelReady: boolean;
  /** Where the project is relative to the user's shell, to start with `cd`; no `cd` when absent. */
  directory?: string;
}

/** The commands that take a freshly scaffolded project to its first successful run. */
export function nextSteps(options: ProjectOptions, state: NextStepsState): NextStep[] {
  const steps: NextStep[] = [];

  if (state.directory) {
    const dir = /^[\w./-]+$/.test(state.directory)
      ? state.directory
      : JSON.stringify(state.directory);
    steps.push({ command: `cd ${dir}` });
  }
  if (!state.installed) {
    steps.push({ command: `${options.packageManager} install` });
  }
  if (options.provider !== 'ollama') {
    steps.push({
      command: 'cp .env.example .env',
      note: `then set ${providerEnvKey(options.provider)} in .env`,
    });
  }
  if (options.provider === 'ollama' && !state.modelReady) {
    steps.push({
      command: `ollama pull ${modelFor(options)}`,
      note: options.docker
        ? 'download the model the agents use, or let `docker compose up -d` pull it into the Ollama container'
        : 'download the model the agents use',
    });
  }
  if (options.template === 'memory' && options.docker) {
    steps.push({ command: 'docker compose up -d redis', note: 'the memory lives in Redis' });
  }
  steps.push({ command: devCommand(options.packageManager) });

  return steps;
}
