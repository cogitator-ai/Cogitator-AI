import * as p from '@clack/prompts';
import { listOllamaModels, resolveOllamaUrl } from '../kit/ollama.js';
import type { ProjectPlan } from '../kit/plan.js';
import { dockerComposeAvailable, longRunningServices, startServices } from '../kit/services.js';

type ComposeServices = Pick<ProjectPlan, 'services' | 'oneShotServices'>;

const OLLAMA_SERVICES = new Set(['ollama', 'ollama-pull']);

/**
 * The services to start: all of them, but the Ollama ones when an Ollama
 * already answers where the project looks for it. The project uses that one,
 * and a second one in compose could not bind its port anyway.
 */
export async function servicesToStart(
  plan: ComposeServices,
  ollamaUrl: string = resolveOllamaUrl()
): Promise<ComposeServices> {
  if (!plan.services.includes('ollama')) return plan;
  if ((await listOllamaModels(ollamaUrl)) === undefined) return plan;
  return {
    services: plan.services.filter((name) => !OLLAMA_SERVICES.has(name)),
    oneShotServices: plan.oneShotServices.filter((name) => !OLLAMA_SERVICES.has(name)),
  };
}

/**
 * Offers to start the project's compose services when it has some and Docker
 * is ready, and starts them on a yes. Only for an interactive run: the caller
 * never asks in CI, with `--yes`, `--json` or without a TTY. Resolves with
 * whether they were started.
 */
export async function offerServices(directory: string, plan: ComposeServices): Promise<boolean> {
  const names = longRunningServices(plan);
  if (names.length === 0 || !(await dockerComposeAvailable(directory))) return false;
  const list = names.join(', ');

  const start = await p.confirm({
    message: `Start ${list} with docker compose now?`,
    initialValue: true,
  });
  if (p.isCancel(start) || !start) return false;

  const spinner = p.spinner();
  spinner.start(`Starting ${list} (the first start pulls the images)`);
  const started = await startServices(directory, plan);
  if (started.status === 'done') {
    spinner.stop(`Started ${list}`);
    return true;
  }
  spinner.error('Not every service started, run "docker compose up -d" once the cause is fixed');
  if (started.status === 'failed') p.log.warn(started.error.message);
  return false;
}
