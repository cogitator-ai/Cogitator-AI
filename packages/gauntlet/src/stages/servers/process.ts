import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { StageContext } from '../../runner/types.js';

/** `packages/gauntlet/`, the working directory of fixture processes (its node_modules resolve). */
export const PACKAGE_DIR = fileURLToPath(new URL('../../../', import.meta.url));

/** A fixture file under `packages/gauntlet/fixtures/servers/`. */
export function serverFixture(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/servers/${name}`, import.meta.url));
}

/** What a fixture prints on one stdout line once it listens. */
export interface ReadyLine {
  ready: true;
  port: number;
  [key: string]: unknown;
}

export interface ChildServer {
  ready: ReadyLine;
  pid: number | undefined;
  /** Everything the process printed so far, trimmed to the tail. */
  output(): string;
}

const STARTUP_TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT = 8_000;

function parseReady(line: string): ReadyLine | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return undefined;
    const port: unknown = Reflect.get(value, 'port');
    if (Reflect.get(value, 'ready') !== true || typeof port !== 'number') return undefined;
    return { ...(value as Record<string, unknown>), ready: true, port };
  } catch {
    return undefined;
  }
}

/**
 * Starts a fixture server in another runtime (Bun, Deno) and waits for its ready line. The
 * process is stopped by the stage cleanup, gracefully first and with SIGKILL after 5 s.
 */
export async function startChildServer(
  ctx: StageContext,
  options: { label: string; command: string; args: string[]; env: Record<string, string> }
): Promise<ChildServer> {
  const child = spawn(options.command, options.args, {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...options.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };
  child.stderr.on('data', append);

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  ctx.onCleanup(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  });

  const ready = await new Promise<ReadyLine>((resolve, reject) => {
    let buffered = '';
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new Error(`${options.label}: ${message}\n${output.slice(-1_500)}`));
    };
    const timer = setTimeout(
      () => fail(`no ready line within ${STARTUP_TIMEOUT_MS / 1000} s`),
      STARTUP_TIMEOUT_MS
    );
    child.stdout.on('data', (chunk: Buffer) => {
      append(chunk);
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseReady(line.trim());
        if (parsed) {
          clearTimeout(timer);
          resolve(parsed);
        }
      }
    });
    child.once('error', (error) => fail(`could not start ${options.command}: ${error.message}`));
    child.once('exit', (code, signal) => fail(`exited early (code ${code}, signal ${signal})`));
    ctx.signal.addEventListener('abort', () => fail('stage aborted'), { once: true });
  });

  return { ready, pid: child.pid, output: () => output };
}
