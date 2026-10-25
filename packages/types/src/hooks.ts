/**
 * Declarative hooks in the format of Claude Code's `settings.json`: commands, HTTP endpoints,
 * model prompts and MCP tools that run at points of an agent run and can steer it
 */

import type { PermissionSettingsOptions } from './permissions';

/**
 * The points of a run a hook can run at, as Claude Code names them. A run is a session here: one
 * `run()` (or `resume()`) of an agent starts with `SessionStart` and ends with `SessionEnd`, a run
 * started from another run's tool call (`agentAsTool()`) is a subagent and fires `SubagentStart`
 * and `SubagentStop` instead
 */
export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PreModelSwitch'
  | 'Stop'
  | 'Notification';

/** Every {@link HookEventName}, in the order of the type */
export const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'Stop',
  'Notification',
];

/** What every hook handler may set */
export interface HookHandlerCommon {
  /**
   * A permission rule (`Bash(git *)`, `Edit(src/**)`) the tool call must match for the handler to
   * run. Only for tool events (`PreToolUse`, `PermissionRequest`, `PostToolUse`,
   * `PostToolUseFailure`): on any other event a handler with `if` never runs
   */
  if?: string;
  /**
   * Seconds before the handler is cancelled. Default 600 for `command`, `http` and `mcp_tool`
   * (30 on `UserPromptSubmit` and `PreModelSwitch`, 1.5 on `SessionEnd`), 30 for `prompt`
   */
  timeout?: number;
  /** Shown while the handler runs, in Claude Code. Kept for compatibility, Cogitator logs it */
  statusMessage?: string;
  /**
   * Whether the action goes ahead when the handler fails (cannot start, exits with a code other
   * than 0 and 2, times out, answers with output that is not valid): `continue` (default) or
   * `block`, which then does what exit code 2 does on the event (denies on `PermissionRequest`).
   * No effect on `Stop` and `SubagentStop`
   */
  onFailure?: 'continue' | 'block';
}

/**
 * A command: the event's JSON on stdin, the answer in its exit code and stdout. Without `args` the
 * command line runs in a shell (`/bin/sh -c`, PowerShell on Windows), with `args` the command is
 * started directly with them, no shell involved. It runs in the project root with the process's
 * environment (without `OTEL_*`) and `CLAUDE_PROJECT_DIR` and `COGITATOR_PROJECT_DIR` set to the
 * project root, which `${CLAUDE_PROJECT_DIR}` in `command` and `args` of the exec form stands for
 */
export interface CommandHookHandler extends HookHandlerCommon {
  type: 'command';
  command: string;
  args?: readonly string[];
  /** The shell of the shell form: `bash` (`/bin/sh -c`, the default) or `powershell` */
  shell?: 'bash' | 'powershell';
  /**
   * Runs in the background without holding the run up: its `additionalContext` and
   * `systemMessage` reach the next model call, its decisions have no effect. Killed when the run
   * ends
   */
  async?: boolean;
}

/**
 * An HTTP endpoint: the event's JSON as the body of a POST, the answer in the response body. The
 * request goes only to `url` (redirects are not followed) and only when `url` passes
 * `allowedHttpHookUrls`
 */
export interface HttpHookHandler extends HookHandlerCommon {
  type: 'http';
  url: string;
  /** Headers, `$VAR` and `${VAR}` in a value replaced by environment variables of `allowedEnvVars` */
  headers?: Readonly<Record<string, string>>;
  /** The environment variables a header may name, the others become empty */
  allowedEnvVars?: readonly string[];
}

/**
 * A question to a model: `prompt` with `$ARGUMENTS` replaced by the event's JSON (appended when it
 * has none), answered with `{ "ok": true }` or `{ "ok": false, "reason": "..." }`
 */
export interface PromptHookHandler extends HookHandlerCommon {
  type: 'prompt';
  prompt: string;
  /** `provider/model` to ask (default `HooksConfig.promptModel`, else `llm.defaultModel`) */
  model?: string;
  /**
   * On `PreToolUse` and `PostToolUse`, an `ok: false` gives the model the reason and the run goes
   * on, instead of ending the run (default false)
   */
  continueOnBlock?: boolean;
}

/** A tool of an MCP server, its text output read as a command's stdout */
export interface McpToolHookHandler extends HookHandlerCommon {
  type: 'mcp_tool';
  server: string;
  tool: string;
  /** Arguments, `${path}` in a string value replaced from the event's JSON (`${tool_input.path}`) */
  input?: Readonly<Record<string, unknown>>;
}

export type HookHandlerConfig =
  CommandHookHandler | HttpHookHandler | PromptHookHandler | McpToolHookHandler;

/**
 * Handlers for the occurrences of an event `matcher` matches: `*`, empty or absent for every one,
 * names separated by `|` or `,` for exact names, anything else a regular expression. Tool events
 * match the tool's name, its MCP name (`mcp__<server>__<tool>`) and the Claude Code names that
 * cover it (`Bash` for `run_command`, `Edit|Write` for the file tools)
 */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: readonly HookHandlerConfig[];
}

/** The `hooks` of a settings file: matcher groups by event */
export type HookSettings = Partial<Record<HookEventName, readonly HookMatcherGroup[]>>;

/** Where the settings files of hooks are read, see `HooksConfig.settings` */
export interface HookSettingsOptions extends Omit<PermissionSettingsOptions, 'trusted'> {
  /**
   * Trust the project at `root` (the working directory of the process without one), so the hooks
   * of its own files (`.claude/settings.json`, `.claude/settings.local.json` and the `.cogitator/`
   * ones) run. Default false: hooks run commands, so a repository's own hooks need the host's
   * explicit trust, and it holds for that root only, not for the workspace of every run.
   * `permissions.settings` with `trusted: true` trusts its `root` for hooks too
   */
  trusted?: boolean;
  /** Absolute project roots whose own hooks run, for a host that serves several projects */
  trustedRoots?: readonly string[];
}

/** Calls MCP tools for `mcp_tool` hooks */
export interface HookMcpCaller {
  callTool(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ text: string; isError?: boolean }>;
}

/**
 * How a handler ended: it answered (`success`), it blocked with exit code 2 (`blocked`), it failed
 * in a way that lets the action go on (`error`: a start failure, another exit code, output that is
 * not valid), it ran out of time (`timeout`), or it was not run (`skipped`: no MCP caller, no
 * model, a type the event does not support)
 */
export type HookOutcome = 'success' | 'blocked' | 'error' | 'timeout' | 'skipped';

/** One handler run, as `HooksConfig.onHookRun` hears it and the thread log keeps it */
export interface HookRunRecord {
  event: HookEventName;
  type: HookHandlerConfig['type'];
  /** The command, URL, model or MCP tool it ran */
  target: string;
  /** The settings file it came from, or `code` for `HooksConfig.hooks` */
  source: string;
  outcome: HookOutcome;
  exitCode?: number;
  durationMs: number;
  /** The decision it gave, as written: `deny`, `block`, `allow`, ... */
  decision?: string;
  /** Why it blocked or failed, or what it says */
  reason?: string;
  /** Its `systemMessage`, meant for a person rather than the model */
  systemMessage?: string;
}

/** Hooks of a runtime: in code, from Claude Code compatible settings files, or both */
export interface HooksConfig {
  /** Hooks in code, as a settings file writes them, which run before those of the files */
  hooks?: HookSettings;
  /**
   * Read the `hooks` of Claude Code compatible settings files: `true` for the places the
   * permission settings use (`permissions.settings`, else the defaults), or where to read. A
   * project's own files count only when the project is trusted (`trusted`). Off by default
   */
  settings?: boolean | HookSettingsOptions;
  /** The model `prompt` hooks ask, as `provider/model` (default `llm.defaultModel`) */
  promptModel?: string;
  /** Calls the MCP tools of `mcp_tool` hooks: without it they are skipped with a warning */
  mcp?: HookMcpCaller;
  /**
   * URL patterns (`*` for any text) an HTTP hook may post to, on top of the `allowedHttpHookUrls`
   * of the settings files. Once any list is set, a hook whose URL matches none is skipped
   */
  allowedHttpHookUrls?: readonly string[];
  /** Environment variables HTTP hook headers may name, on top of `httpHookAllowedEnvVars` of the files */
  httpHookAllowedEnvVars?: readonly string[];
  /**
   * The environment command hooks get: `inherit` (default) the process's own without `OTEL_*`,
   * as Claude Code passes it, or `{ allow }` only the variables named (`PATH` among them when a
   * hook calls programs by name). `CLAUDE_PROJECT_DIR` and `COGITATOR_PROJECT_DIR` are set either
   * way. A server that holds secrets in its environment should allow only what hooks need
   */
  env?: 'inherit' | { allow: readonly string[] };
  /** Bytes of a command's stdout and of its stderr, or of an HTTP response, read at most (default 1 MiB) */
  maxOutputBytes?: number;
  /** Hears every handler run, for showing a hook's `systemMessage` to a person */
  onHookRun?: (run: HookRunRecord) => void;
}
