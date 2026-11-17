/**
 * cogitator bridge mcp | caller - what a harness runs for a session to give it the bridge's
 * tools: the server of the tools, and the hook that tells the tools which session calls
 */

import { readFileSync } from 'node:fs';
import {
  BridgeClient,
  answerPermissionHook,
  bridgePaths,
  isBridgeError,
  type BridgeAdapter,
} from '@cogitator-ai/bridge';
import { BRIDGE_INSTRUCTIONS, bridgeTools } from '@cogitator-ai/bridge/tools';
import { MCPServer } from '@cogitator-ai/mcp/server';
import { bridgeAdapters } from '../utils/bridge-adapters.js';
import { CommandError, EXIT, reportFailure } from '../utils/cli.js';

/** The name the server gives itself. A harness knows it by the name it was registered under. */
export const BRIDGE_SERVER_NAME = 'cogitator-bridge';

function cliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
  ) as { version: string };
  return manifest.version;
}

export interface BridgeMcpOptions {
  /** The folder of the bridge's files, when it is not the default one */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The folder the session works in, the current one by default */
  cwd?: string;
}

/**
 * The server of the bridge's tools over stdio, for the session of the harness that started it.
 * It holds no connection to the dispatcher: every tool call makes its own, so the server may be
 * started before the dispatcher and lives through its restarts.
 */
export function createBridgeMcpServer(options: BridgeMcpOptions = {}): MCPServer {
  const env = options.env ?? process.env;
  const server = new MCPServer({
    name: BRIDGE_SERVER_NAME,
    version: cliVersion(),
    transport: 'stdio',
    logging: false,
    instructions: BRIDGE_INSTRUCTIONS,
  });
  server.registerTools(
    bridgeTools({
      socketPath: bridgePaths({ ...(options.home && { home: options.home }), env }).socket,
      env,
      ...(options.cwd && { cwd: options.cwd }),
    })
  );
  return server;
}

/**
 * cogitator bridge mcp: serves the tools on stdin and stdout until the harness closes them, or
 * the process is told to stop.
 */
export async function runBridgeMcp(flags: { home?: string }): Promise<number> {
  let server: MCPServer;
  try {
    server = createBridgeMcpServer({ ...(flags.home && { home: flags.home }) });
    await server.start();
  } catch (error) {
    return reportFailure(error, { json: false });
  }
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await server.stop().catch(() => undefined);
  return 0;
}

/** What the hook command works with */
export interface BridgeCallerContext {
  /** Where the answer of the hook goes: the harness reads it from stdout */
  write(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** What the harness wrote to the hook */
  stdin(): Promise<string | undefined>;
  adapters?: readonly BridgeAdapter[];
}

async function pipedInput(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const defaultCallerContext = (): BridgeCallerContext => ({
  write: (text) => process.stdout.write(text),
  env: process.env,
  cwd: process.cwd(),
  stdin: pipedInput,
});

export interface BridgeStuckFlags {
  hook: string;
  home?: string;
}

/**
 * cogitator bridge stuck --hook <harness>: the hook a harness runs when a session begins to
 * wait for a person at its own window, such as with its permission dialog open. It tells the
 * bridge, which lets whoever handed the session a job know that the job stands still. It says
 * nothing to the harness and never exits with 2: the dialog is the person's either way. Without
 * a dispatcher there is nobody to tell, which is fine.
 */
export async function runBridgeStuck(
  flags: BridgeStuckFlags,
  context: BridgeCallerContext = defaultCallerContext()
): Promise<number> {
  try {
    const harness = flags.hook.trim().toLowerCase();
    const adapters =
      context.adapters ?? bridgeAdapters(context.env, { ...(flags.home && { home: flags.home }) });
    const adapter = adapters.find((candidate) => candidate.harness === harness);
    if (!adapter?.stuckHook) {
      throw new CommandError(
        `No adapter knows when a session of "${flags.hook}" waits for a person`
      );
    }
    const hookInput = await context.stdin();
    const stuck =
      hookInput === undefined
        ? undefined
        : adapter.stuckHook({ env: context.env, cwd: context.cwd, hookInput });
    if (!stuck) return 0;
    let client: BridgeClient;
    try {
      client = await BridgeClient.connect({
        socketPath: bridgePaths({ ...(flags.home && { home: flags.home }), env: context.env })
          .socket,
        caller: stuck.caller,
      });
    } catch (error) {
      if (isBridgeError(error) && error.code === 'not_running') return 0;
      throw error;
    }
    try {
      await client.stuck({ what: stuck.what });
    } finally {
      await client.close();
    }
    return 0;
  } catch (error) {
    reportFailure(error, { json: false });
    return EXIT.failed;
  }
}

export interface BridgePermitFlags {
  hook: string;
  /** Seconds to wait for the decision */
  timeout?: number;
  /** The name the bridge gave the session, for one it started */
  agent?: string;
  home?: string;
}

const DEFAULT_PERMIT_S = 600;

/**
 * cogitator bridge permit --hook <harness>: the hook a harness runs when a session needs leave
 * for a call. It takes the call to the bridge as a permission request on the job the session
 * carries out, waits for the verdict and answers the harness with it. It answers with nothing,
 * so the harness decides as it would without the hook, when the input is not that of such a
 * hook, the session carries out no one job, no dispatcher runs or nobody decided in time. It
 * never exits with 2, and a failure of its own never refuses the call.
 */
export async function runBridgePermit(
  flags: BridgePermitFlags,
  context: BridgeCallerContext = defaultCallerContext()
): Promise<number> {
  try {
    const harness = flags.hook.trim().toLowerCase();
    const adapters =
      context.adapters ?? bridgeAdapters(context.env, { ...(flags.home && { home: flags.home }) });
    const adapter = adapters.find((candidate) => candidate.harness === harness);
    if (!adapter?.permissionHook) {
      throw new CommandError(`No adapter asks leave for the sessions of "${flags.hook}"`);
    }
    const hookInput = await context.stdin();
    const read =
      hookInput === undefined
        ? undefined
        : adapter.permissionHook({ env: context.env, cwd: context.cwd, hookInput });
    if (!read) return 0;
    const started = flags.agent?.trim();
    const call = started ? { ...read, caller: { ...read.caller, agentName: started } } : read;
    const answer = await answerPermissionHook({
      socketPath: bridgePaths({ ...(flags.home && { home: flags.home }), env: context.env }).socket,
      call,
      timeoutMs: (flags.timeout ?? DEFAULT_PERMIT_S) * 1000,
    });
    if (answer !== undefined) context.write(answer);
    return 0;
  } catch (error) {
    reportFailure(error, { json: false });
    return EXIT.failed;
  }
}

/**
 * cogitator bridge caller --hook <harness>: the hook a harness runs before a call of a bridge
 * tool. It answers with the arguments of the call and the session that makes it, and with
 * nothing when the input names no session: the call then goes on as it was. It never exits with
 * 2, which a harness would read as a refusal of the tool call.
 */
export async function runBridgeCaller(
  flags: { hook: string },
  context: BridgeCallerContext = defaultCallerContext()
): Promise<number> {
  try {
    const harness = flags.hook.trim().toLowerCase();
    const adapters = context.adapters ?? bridgeAdapters(context.env);
    const adapter = adapters.find((candidate) => candidate.harness === harness);
    if (!adapter?.toolCallHook) {
      throw new CommandError(`No adapter names the sessions of "${flags.hook}" to the tools`);
    }
    const hookInput = await context.stdin();
    const answer = adapter.toolCallHook({
      env: context.env,
      cwd: context.cwd,
      ...(hookInput !== undefined && { hookInput }),
    });
    if (answer !== undefined) context.write(answer);
    return 0;
  } catch (error) {
    reportFailure(error, { json: false });
    return EXIT.failed;
  }
}
