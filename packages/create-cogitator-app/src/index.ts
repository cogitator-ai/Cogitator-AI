import * as p from '@clack/prompts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { banner } from './utils/logger.js';
import { parseArgs, collectOptions } from './prompts.js';
import { scaffold } from './scaffold.js';
import { nextSteps } from './next-steps.js';
import { DOCS_URL } from './utils/links.js';
import { modelFor } from './utils/providers.js';
import {
  hasOllamaModel,
  listOllamaModels,
  pullOllamaModel,
  resolveOllamaUrl,
} from './utils/ollama.js';
import type { ProjectOptions } from './types.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

/**
 * Whether the Ollama model the agents use is pulled once this returns. When it is
 * missing and the user is at the prompt, offers to pull it now.
 */
async function prepareOllamaModel(options: ProjectOptions, interactive: boolean): Promise<boolean> {
  const model = modelFor(options);
  const baseUrl = resolveOllamaUrl();
  const installed = await listOllamaModels(baseUrl);

  if (!installed) {
    p.log.warn(
      `Ollama is not running at ${baseUrl}. Start it and pull ${model} before the first run.`
    );
    return false;
  }
  if (hasOllamaModel(installed, model)) return true;
  if (!interactive) return false;

  const pull = await p.confirm({
    message: `${model} is not installed in Ollama. Pull it now?`,
    initialValue: true,
  });
  if (p.isCancel(pull) || !pull) return false;

  const s = p.spinner();
  s.start(`Pulling ${model}`);
  try {
    await pullOllamaModel(baseUrl, model, (status) => s.message(`Pulling ${model}: ${status}`));
    s.stop(`Pulled ${model}`);
    return true;
  } catch (error) {
    s.stop(error instanceof Error ? error.message : `Failed to pull ${model}`);
    return false;
  }
}

async function main() {
  banner(pkg.version);

  p.intro(pc.cyan("Let's build something with AI agents"));

  const args = parseArgs(process.argv.slice(2));
  const options = await collectOptions(args);

  const result = await scaffold(options);

  if (result.install.status === 'failed') {
    p.log.warn(`${options.packageManager} install failed: ${result.install.error.message}`);
  }
  if (result.git.status === 'failed') {
    p.log.warn(`git init failed: ${result.git.error.message}`);
  }

  const modelReady =
    options.provider === 'ollama' ? await prepareOllamaModel(options, !args.yes) : true;

  const steps = nextSteps(options, {
    installed: result.install.status === 'done',
    modelReady,
    directory: path.relative(process.cwd(), options.path) || undefined,
  });

  p.outro(
    [
      pc.green('Done! ') + 'Next steps:',
      '',
      ...steps.map(
        (step) => `  ${pc.cyan(step.command)}${step.note ? pc.dim(`  # ${step.note}`) : ''}`
      ),
      '',
      pc.dim(`Docs: ${DOCS_URL}`),
    ].join('\n')
  );
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
