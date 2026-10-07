import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGISTRY_PATH, type RegistryInfo } from '@cogitator-ai/studio';

export { describeRegistry, REGISTRY_PATH } from '@cogitator-ai/studio';
export type {
  AgentInfo,
  RegistryInfo,
  SwarmInfo,
  ToolInfo,
  WorkflowInfo,
} from '@cogitator-ai/studio';

/** What the inspection child process sends back. */
export type InspectionMessage = { ok: true; registry: RegistryInfo } | { ok: false; error: string };

function workerEntry(): { path: string; execArgv: string[] } {
  const compiled = fileURLToPath(new URL('./registry-worker.js', import.meta.url));
  if (existsSync(compiled)) return { path: compiled, execArgv: [] };
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return {
    path: fileURLToPath(new URL('./registry-worker.ts', import.meta.url)),
    execArgv: ['--import', tsx],
  };
}

/**
 * Loads the registry of the project in `projectDir` in a child process and
 * describes it. A fresh process sees the code as it is now, keeps the
 * project's output and connections away from the caller, and is killed when
 * it takes longer than `timeoutMs`.
 */
export function inspectRegistry(projectDir: string, timeoutMs = 60_000): Promise<RegistryInfo> {
  if (!existsSync(join(projectDir, REGISTRY_PATH))) {
    return Promise.reject(
      new Error(
        `${REGISTRY_PATH} not found in ${projectDir}: projects from create-cogitator-app register their agents there`
      )
    );
  }
  const entry = workerEntry();
  return new Promise((resolve, reject) => {
    const child = fork(entry.path, [projectDir], {
      cwd: projectDir,
      execArgv: entry.execArgv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`Loading ${REGISTRY_PATH} took longer than ${timeoutMs} ms`)));
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('message', (message: InspectionMessage) => {
      settle(() => (message.ok ? resolve(message.registry) : reject(new Error(message.error))));
    });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code) => {
      settle(() =>
        reject(
          new Error(
            `Loading ${REGISTRY_PATH} failed (exit ${code ?? 'signal'})${stderr ? `:\n${stderr.trim().split('\n').slice(-20).join('\n')}` : ''}`
          )
        )
      );
    });
  });
}
