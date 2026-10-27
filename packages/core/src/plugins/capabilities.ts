/**
 * What a plugin may do beyond its own folder, granted by the permission rules of its manifest and
 * decided by the permission engine: reading and writing files, fetching URLs and running
 * commands. Nothing is allowed that no rule allows
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type PluginExecResult,
  type PluginFetchResponse,
  type PluginFiles,
  type PluginPermissionsSpec,
  type Tool,
} from '@cogitator-ai/types';
import { PermissionRuleSet, resolvePermission } from '../permissions/engine';
import { mcpNamePart, targetCovers } from '../permissions/rules';

/** Largest file `files.readFile` reads and largest response body `fetch` reads */
export const MAX_PLUGIN_READ_BYTES = 10 * 1024 * 1024;

/** Most bytes of stdout and of stderr `exec` keeps */
const MAX_EXEC_OUTPUT = 1024 * 1024;

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

function capability(
  name: string,
  kind: 'read' | 'edit' | 'command' | 'fetch',
  field: 'path' | 'command' | 'url'
): Tool {
  const read = (params: unknown): string => {
    const value = (params as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  };
  return {
    name,
    description: `A plugin ${kind}`,
    parameters: z.object({ [field]: z.string() }).loose(),
    access: {
      kind,
      ...(field === 'path' && { paths: (params: unknown) => [read(params)] }),
      ...(field === 'command' && {
        command: (params: unknown) => read(params),
        cwd: (params: unknown) => {
          const cwd = (params as Record<string, unknown>).cwd;
          return typeof cwd === 'string' ? cwd : undefined;
        },
      }),
      ...(field === 'url' && { url: (params: unknown) => read(params) }),
    },
    execute: async () => undefined,
    toJSON: () => ({ name, description: name, parameters: { type: 'object', properties: {} } }),
  };
}

/**
 * The tool an MCP call of a plugin is checked as: `mcp__<server>__<tool>`, matched by the rules
 * that name its server or tool (`mcp__github`, `mcp__github__create_issue`)
 */
function mcpCapability(server: string, tool: string): Tool {
  const name = `mcp__${mcpNamePart(server)}__${mcpNamePart(tool)}`;
  return {
    name,
    description: 'A plugin MCP call',
    parameters: z.object({}).loose(),
    mcp: { server, tool },
    execute: async () => undefined,
    toJSON: () => ({ name, description: name, parameters: { type: 'object', properties: {} } }),
  };
}

const READ = capability('plugin_read', 'read', 'path');
const EDIT = capability('plugin_edit', 'edit', 'path');
const COMMAND = capability('plugin_command', 'command', 'command');
const FETCH = capability('plugin_fetch', 'fetch', 'url');

/**
 * The rule name that lets a plugin register routines and triggers of the trigger manager:
 * `"Routine"` in the `allow` of its `permissions`
 */
export const PLUGIN_ROUTINE_RULE = 'Routine';

const ROUTINE: Tool = {
  name: PLUGIN_ROUTINE_RULE,
  description: 'A plugin routine',
  parameters: z.object({}).loose(),
  execute: async () => undefined,
  toJSON: () => ({
    name: PLUGIN_ROUTINE_RULE,
    description: PLUGIN_ROUTINE_RULE,
    parameters: { type: 'object', properties: {} },
  }),
};

/** `path` with its links followed, as the permission engine compares real paths */
function realOf(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** Variables that change what a program loads or runs before its own code */
const LOADER_VARIABLES = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'ENV',
  'BASH_ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'IFS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'XDG_CONFIG_HOME',
]);

const LOADER_PREFIXES = ['LD_', 'DYLD_', 'NPM_CONFIG_', 'GIT_', 'BUN_', 'DENO_', 'UV_', 'PIP_'];

/**
 * The first of the variables `names` that changes what a program loads or how a shell starts (a preload,
 * a module path, a package manager's config): such a variable turns an allowed command into any
 * code, so a plugin with `permissions` may not set it for its MCP servers
 */
export function loaderVariableOf(names: Iterable<string>): string | undefined {
  return [...names].find((name) => {
    const upper = name.toUpperCase();
    return (
      LOADER_VARIABLES.has(upper) || LOADER_PREFIXES.some((prefix) => upper.startsWith(prefix))
    );
  });
}

/** What a plugin asks for, in the shape a permission rule checks */
export type CapabilityRequest =
  | { kind: 'read' | 'edit'; path: string }
  | { kind: 'command'; command: string; cwd?: string }
  | { kind: 'fetch'; url: string }
  | { kind: 'mcp'; server: string; tool: string };

/**
 * Decides what a plugin asks for with its `permissions` (the rules it was granted) and the host's
 * `deny` rules over them, in `dontAsk` mode: what no allow rule covers is refused
 */
export class PluginPermissions {
  private readonly rules: PermissionRuleSet;
  readonly warnings: readonly string[];
  /**
   * `granted` when the plugin's own rules decide, `hostDeny` when only the host's deny rules do
   * (a plugin without `permissions`, see `hostDenyOnly`)
   */
  scope: 'granted' | 'hostDeny' = 'granted';

  private readonly projectRoot: string;

  constructor(
    private readonly plugin: string,
    granted: PluginPermissionsSpec | undefined,
    hostDeny: readonly string[],
    projectRoot: string
  ) {
    this.projectRoot = realOf(projectRoot);
    this.rules = new PermissionRuleSet([
      {
        layer: 'session',
        allow: [...(granted?.allow ?? [])],
        deny: [...(granted?.deny ?? []), ...hostDeny],
        anchor: this.projectRoot,
        origin: `plugin ${plugin}`,
      },
    ]);
    this.warnings = this.rules.warnings;
  }

  /**
   * The checks of a plugin that declares no `permissions`, for the hooks and MCP servers its files
   * bring: they run as in Claude Code, unless a `deny` rule of the host refuses them
   */
  static hostDenyOnly(
    plugin: string,
    hostDeny: readonly string[],
    projectRoot: string
  ): PluginPermissions {
    const checks = new PluginPermissions(
      plugin,
      { allow: ['Bash', 'WebFetch'] },
      hostDeny,
      projectRoot
    );
    checks.scope = 'hostDeny';
    return checks;
  }

  /** Whether the rules allow `request`, and why */
  async decide(request: CapabilityRequest): Promise<{ allowed: boolean; reason: string }> {
    const [tool, args]: [Tool, Record<string, unknown>] =
      request.kind === 'command'
        ? [COMMAND, { command: request.command, ...(request.cwd && { cwd: request.cwd }) }]
        : request.kind === 'fetch'
          ? [FETCH, { url: request.url }]
          : request.kind === 'mcp'
            ? [mcpCapability(request.server, request.tool), {}]
            : [request.kind === 'read' ? READ : EDIT, { path: request.path }];
    const decision = await resolvePermission(tool, args, {
      mode: 'dontAsk',
      rules: this.rules,
      needsApproval: true,
      cwd: this.projectRoot,
      projectRoot: this.projectRoot,
    });
    const reason = decision.rule ? `${decision.reason} (${decision.rule.rule})` : decision.reason;
    if (request.kind === 'mcp' && this.scope === 'hostDeny') {
      const refused = decision.decision === 'deny' && decision.decidedBy === 'rule';
      return { allowed: !refused, reason };
    }
    return { allowed: decision.decision === 'allow', reason };
  }

  /**
   * Throws `PLUGIN_PERMISSION_DENIED` unless an `allow` rule `Routine` lets the plugin register
   * routines and triggers and no `deny` or `ask` rule names it. A routine starts runs on its
   * own, without a person: nothing allows it but that rule
   */
  checkRoutines(): void {
    const covers = (behavior: 'allow' | 'deny' | 'ask') =>
      this.rules.rules(behavior).some((rule) => targetCovers(rule.target, ROUTINE));
    const allowed =
      this.scope === 'granted' &&
      this.rules
        .rules('allow')
        .some(
          (rule) => rule.parsed.specifier === undefined && targetCovers(rule.target, ROUTINE)
        ) &&
      !covers('deny') &&
      !covers('ask');
    if (allowed) return;
    throw new CogitatorError({
      message: `Plugin ${this.plugin} may not register routines or triggers: its permissions do not allow "${PLUGIN_ROUTINE_RULE}"`,
      code: ErrorCode.PLUGIN_PERMISSION_DENIED,
      details: { plugin: this.plugin },
    });
  }

  /** Throws `PLUGIN_PERMISSION_DENIED` unless the rules allow `request` */
  async check(request: CapabilityRequest): Promise<void> {
    const { allowed, reason } = await this.decide(request);
    if (allowed) return;
    const what =
      request.kind === 'command'
        ? `run "${request.command}"`
        : request.kind === 'fetch'
          ? `fetch ${request.url}`
          : request.kind === 'mcp'
            ? `call the MCP tool ${request.tool} of ${request.server}`
            : `${request.kind === 'read' ? 'read' : 'write'} ${request.path}`;
    throw new CogitatorError({
      message: `Plugin ${this.plugin} may not ${what}: its permissions allow no such request (${reason})`,
      code: ErrorCode.PLUGIN_PERMISSION_DENIED,
      details: { plugin: this.plugin, request },
    });
  }
}

/** The capabilities of `permissions` for one plugin, paths relative to `projectRoot` */
export function pluginCapabilities(
  permissions: PluginPermissions,
  projectRoot: string,
  signal: AbortSignal
): {
  files: PluginFiles;
  fetch: (
    url: string,
    init?: { method?: string; headers?: Readonly<Record<string, string>>; body?: string }
  ) => Promise<PluginFetchResponse>;
  exec: (
    command: string,
    options?: { cwd?: string; timeoutMs?: number }
  ) => Promise<PluginExecResult>;
} {
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(projectRoot, path));
  return {
    files: {
      async readFile(path) {
        await permissions.check({ kind: 'read', path });
        const content = await readFile(absolute(path));
        if (content.byteLength > MAX_PLUGIN_READ_BYTES) {
          throw new CogitatorError({
            message: `${path} is larger than ${MAX_PLUGIN_READ_BYTES} bytes`,
            code: ErrorCode.VALIDATION_ERROR,
          });
        }
        return content.toString('utf8');
      },
      async writeFile(path, content) {
        await permissions.check({ kind: 'edit', path });
        await mkdir(dirname(absolute(path)), { recursive: true });
        await writeFile(absolute(path), content, 'utf8');
      },
      async list(path) {
        await permissions.check({ kind: 'read', path });
        const entries = await readdir(absolute(path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
        }));
      },
    },
    async fetch(url, init) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new CogitatorError({
          message: `${url} is not a URL`,
          code: ErrorCode.VALIDATION_ERROR,
        });
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new CogitatorError({
          message: `A plugin may fetch only http and https URLs, not ${parsed.protocol}`,
          code: ErrorCode.PLUGIN_PERMISSION_DENIED,
        });
      }
      await permissions.check({ kind: 'fetch', url });
      const response = await fetch(parsed, {
        ...(init?.method !== undefined && { method: init.method }),
        ...(init?.headers !== undefined && { headers: { ...init.headers } }),
        ...(init?.body !== undefined && { body: init.body }),
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS)]),
      });
      const text = await readCapped(response);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text,
      };
    },
    async exec(command, options) {
      const cwd = absolute(options?.cwd ?? '.');
      await permissions.check({ kind: 'command', command, cwd });
      return runShell(command, cwd, options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, signal);
    },
  };
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PLUGIN_READ_BYTES) {
      await reader.cancel();
      throw new CogitatorError({
        message: `The response is larger than ${MAX_PLUGIN_READ_BYTES} bytes`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The variables of the host a command of a plugin gets: where programs are, never its secrets */
const EXEC_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'USERPROFILE',
];

function execEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of EXEC_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<PluginExecResult> {
  return new Promise((resolvePromise, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(
      windows ? 'cmd.exe' : '/bin/sh',
      windows ? ['/d', '/s', '/c', command] : ['-c', command],
      {
        cwd,
        env: execEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !windows,
      }
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const kill = () => {
      try {
        if (!windows && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_EXEC_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_EXEC_OUTPUT) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode: code,
        stdout: stdout.slice(0, MAX_EXEC_OUTPUT),
        stderr: stderr.slice(0, MAX_EXEC_OUTPUT),
        timedOut,
      });
    });
  });
}
