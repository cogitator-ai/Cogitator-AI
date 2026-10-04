import type { Server } from 'node:http';
import type { RunResult } from '@cogitator-ai/types';

export const CORE = '@cogitator-ai/core';
export const TYPES = '@cogitator-ai/types';
export const MCP = '@cogitator-ai/mcp';
export const A2A = '@cogitator-ai/a2a';
export const WASM_TOOLS = '@cogitator-ai/wasm-tools';
export const SANDBOX = '@cogitator-ai/sandbox';
export const SELF_MODIFYING = '@cogitator-ai/self-modifying';

/** Names of the tools a run called, in order. */
export function calledTools(run: RunResult): string[] {
  return run.toolCalls.map((call) => call.name);
}

/** Throws unless the run called `name` at least once. */
export function assertCalled(run: RunResult, name: string): void {
  if (!run.toolCalls.some((call) => call.name === name)) {
    throw new Error(
      `The model answered without calling ${name} (called: ${calledTools(run).join(', ') || 'nothing'})`
    );
  }
}

/** The first `max` characters of a text, for evidence. */
export function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Listens on `127.0.0.1:port` and resolves once the socket is bound. */
export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Closes a server and its keep-alive connections. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

/** Rejects when `work` settles neither way within `ms`; used to prove a timeout actually fired. */
export async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
