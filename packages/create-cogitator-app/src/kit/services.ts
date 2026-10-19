import type { ProjectPlan } from './plan.js';
import { runCommand, tail } from './process.js';
import type { StepResult } from './scaffold.js';

/** How long `docker compose up --wait` waits for the services to be running or healthy. */
export const SERVICES_WAIT_SECONDS = 180;

/** The longest a start may take, image pulls included. */
const START_TIMEOUT_MS = 15 * 60_000;

/**
 * Whether Docker can start the project's services: the compose plugin is
 * installed and the daemon answers. Never throws.
 */
export async function dockerComposeAvailable(cwd: string): Promise<boolean> {
  try {
    const compose = await runCommand('docker', ['compose', 'version'], { cwd, timeoutMs: 10_000 });
    if (compose.code !== 0) return false;
    const daemon = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd,
      timeoutMs: 15_000,
    });
    return daemon.code === 0;
  } catch {
    return false;
  }
}

/** The services that keep running, the ones a start waits for. */
export function longRunningServices(
  plan: Pick<ProjectPlan, 'services' | 'oneShotServices'>
): string[] {
  return plan.services.filter((name) => !plan.oneShotServices.includes(name));
}

async function composeUp(directory: string, args: readonly string[]): Promise<StepResult> {
  try {
    const result = await runCommand('docker', ['compose', 'up', '--detach', ...args], {
      cwd: directory,
      timeoutMs: START_TIMEOUT_MS,
    });
    if (result.code === 0) return { status: 'done' };
    return {
      status: 'failed',
      error: new Error(`docker compose up exited with ${result.code}:\n${tail(result.output)}`),
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Starts the compose services of a scaffolded project in `directory` and
 * waits until the long-running ones are healthy, or running when they have no
 * healthcheck. One-shot services, such as the one that pulls the Ollama
 * models, start afterwards without waiting, since `--wait` is not meant for
 * containers that exit. Resolves with how it went and never throws.
 */
export async function startServices(
  directory: string,
  plan: Pick<ProjectPlan, 'services' | 'oneShotServices'>
): Promise<StepResult> {
  if (plan.services.length === 0)
    return { status: 'skipped', reason: 'the project has no compose services' };
  const longRunning = longRunningServices(plan);
  if (longRunning.length > 0) {
    const started = await composeUp(directory, [
      '--wait',
      '--wait-timeout',
      String(SERVICES_WAIT_SECONDS),
      ...longRunning,
    ]);
    if (started.status !== 'done') return started;
  }
  const oneShot = plan.services.filter((name) => plan.oneShotServices.includes(name));
  return oneShot.length > 0 ? composeUp(directory, oneShot) : { status: 'done' };
}
