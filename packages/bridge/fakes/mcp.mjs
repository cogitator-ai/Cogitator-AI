/**
 * The MCP client of the fake harnesses: starts the stdio servers a session is configured with
 * and calls their tools the way the real harnesses do, as far as the bridge depends on it.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * A server of tools is a process that loads the whole runtime before it answers its first
 * request: on a busy CI runner that took over fifteen seconds, so a request waits a minute
 */
const REQUEST_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = '2025-06-18';

/**
 * @typedef {object} ServerConfig
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 */

/** @typedef {{ name: string, annotations?: Record<string, unknown> }} ListedTool */

/** @typedef {{ text: string, isError: boolean }} ToolAnswer */

/**
 * One running server. Its stderr is dropped: a server writes its diagnostics there.
 * @param {ServerConfig} config
 * @param {object} options
 * @param {string} options.cwd
 * @param {NodeJS.ProcessEnv} options.env the whole environment of the server process
 * @param {{ name: string, title?: string, version: string }} options.clientInfo
 */
function startServer(config, { cwd, env, clientInfo }) {
  const child = spawn(config.command, config.args ?? [], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const waiting = new Map();
  let nextId = 0;
  let failure;
  const fail = (error) => {
    failure ??= error;
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(failure);
    }
    waiting.clear();
  };
  child.on('error', (error) => fail(new Error(`MCP server failed to start: ${error.message}`)));
  child.on('exit', () => fail(new Error('MCP server exited')));
  child.stdin.on('error', () => undefined);
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const call = waiting.get(message.id);
    if (!call || message.method !== undefined) return;
    waiting.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message ?? 'MCP error'));
    else call.resolve(message.result);
  });

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`MCP server did not answer ${method}`));
      }, REQUEST_TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) });
    });

  const ready = (async () => {
    const hello = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const { tools } = await request('tools/list', {});
    return { instructions: hello.instructions, tools };
  })();
  ready.catch(() => undefined);

  return {
    ready,
    /**
     * @param {string} tool
     * @param {Record<string, unknown>} args
     * @param {Record<string, unknown>} meta
     * @returns {Promise<ToolAnswer>}
     */
    async call(tool, args, meta) {
      const result = await request('tools/call', { name: tool, arguments: args, _meta: meta });
      const text = (result.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      return { text, isError: result.isError === true };
    },
    close() {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

/**
 * The servers of one session, each started when a tool of it is first called.
 * @param {Record<string, ServerConfig>} configs by the name the session knows the server by
 * @param {object} options
 * @param {string} options.cwd
 * @param {(config: ServerConfig) => NodeJS.ProcessEnv} options.envOf
 * @param {{ name: string, title?: string, version: string }} options.clientInfo
 */
export function toolServers(configs, { cwd, envOf, clientInfo }) {
  const running = new Map();
  return {
    names: () => Object.keys(configs),
    /** @returns {Promise<{ server: ReturnType<typeof startServer>, tools: ListedTool[], instructions?: string } | undefined>} */
    async get(name) {
      if (!Object.hasOwn(configs, name)) return undefined;
      if (!running.has(name)) {
        const config = configs[name];
        running.set(name, startServer(config, { cwd, env: envOf(config), clientInfo }));
      }
      const server = running.get(name);
      return { server, ...(await server.ready) };
    },
    close() {
      for (const server of running.values()) server.close();
      running.clear();
    },
  };
}

/** `K=V` pairs of a command line as an object. A pair without `=` is refused with undefined */
export function envPairs(pairs) {
  const env = {};
  for (const pair of pairs) {
    const cut = pair.indexOf('=');
    if (cut <= 0) return undefined;
    env[pair.slice(0, cut)] = pair.slice(cut + 1);
  }
  return env;
}
