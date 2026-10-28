/**
 * The operating system sandbox a local workspace runs its commands in: Seatbelt (`sandbox-exec`)
 * on macOS, bubblewrap (`bwrap`) on Linux. Files a command may write and read, and the network
 * hosts it may reach through the sandbox's own proxy, with the semantics of the `sandbox`
 * settings of Claude Code
 */

/** How the sandbox is enforced: Seatbelt on macOS, bubblewrap on Linux */
export type OsSandboxKind = 'seatbelt' | 'bubblewrap';

/**
 * What sandboxed commands may read and write. Paths are absolute, `~/` for the home directory,
 * or relative to the workspace root. A trailing `/**` covers the same directory as the path
 * without it. `*`, `?`, `**` and `[...]` are wildcards: on macOS in every list, on Linux in
 * `denyRead` and `allowRead` (expanded to what exists when the command starts)
 */
export interface OsSandboxFilesystemPolicy {
  /**
   * Where commands may write besides the workspace root and the sandbox's own temporary directory
   * (`TMPDIR`). The protected paths stay read-only even inside these
   */
  allowWrite?: readonly string[];
  /** Where commands may not write, even inside a writable directory: the deny wins */
  denyWrite?: readonly string[];
  /** What commands may not read (reads are allowed everywhere else) */
  denyRead?: readonly string[];
  /**
   * What commands may read again inside a `denyRead` region. The narrower entry wins: a `denyRead`
   * inside a wider `allowRead` still holds, an `allowRead` inside a wider `denyRead` reopens.
   * It reopens only a path it names inside the denied region: an entry that reaches into one only
   * through a symlink is ignored
   */
  allowRead?: readonly string[];
  /**
   * Skip filesystem isolation, keep network isolation: commands read and write everything this
   * process can, the protected paths included. Default false
   */
  disabled?: boolean;
}

/**
 * Which hosts sandboxed commands reach. A command has no route out but the sandbox's proxy
 * (HTTP `CONNECT` and SOCKS5), which checks each host against these lists. An entry is a host
 * (`github.com`, exactly that host), a wildcard (`*.npmjs.org`, its subdomains), `*` (every host),
 * an IPv4 address or a bracketed IPv6 one (`[::1]`), each with an optional `:port`
 */
export interface OsSandboxNetworkPolicy {
  /** Hosts commands reach without anyone asked */
  allowedDomains?: readonly string[];
  /** Hosts refused whatever else allows them: a deny wins over every allow */
  deniedDomains?: readonly string[];
  /**
   * Refuse every host outside `allowedDomains` instead of asking `onUnknownHost`, and refuse
   * the hosts a command lists for itself (`WorkspaceExecOptions.allowedDomains`). Default false
   */
  strictAllowlist?: boolean;
  /**
   * macOS: let commands listen on local ports and connect to any port on `localhost` directly
   * (a dev server). Linux gives each command a loopback of its own, so it has no effect there.
   * Default false
   */
  allowLocalBinding?: boolean;
  /** macOS: Unix socket paths commands may connect to, such as an SSH agent's. Default none */
  allowUnixSockets?: readonly string[];
  /**
   * Let commands connect to every Unix socket. On Linux it also lets the sandbox run without its
   * seccomp filter (on `--disable-userns` alone), which is otherwise required. Default false
   */
  allowAllUnixSockets?: boolean;
}

/** Credentials sandboxed commands must not see */
export interface OsSandboxCredentialsPolicy {
  /** Environment variables removed from the environment of sandboxed commands */
  envVars?: readonly string[];
  /** Files and directories sandboxed commands may not read, added to `denyRead` */
  files?: readonly string[];
}

/**
 * The policy of an OS sandbox, see `OsSandbox` of `@cogitator-ai/sandbox`. The `sandbox`
 * section of Claude Code settings (`.claude/settings.json`) reads into one, see
 * `loadSandboxPolicy` of `@cogitator-ai/core`
 */
export interface OsSandboxPolicy {
  /** Whether commands run in the sandbox. Default true for a policy given in code */
  enabled?: boolean;
  /**
   * Refuse to run commands when the sandbox cannot start on this machine (no `sandbox-exec`,
   * no `bwrap` or `socat`, user namespaces blocked), with a `SANDBOX_UNAVAILABLE` error naming
   * why, instead of running them unprotected. Default true. With false a command then runs
   * outside the sandbox, with a warning, and its result says so
   */
  failIfUnavailable?: boolean;
  /**
   * Whether a command that runs in the sandbox skips the approval a command would need
   * (`run_command`'s own, a bare `Bash` ask rule). Deny rules, ask rules with a pattern, removals
   * of critical paths and plan mode still apply. Default true
   */
  autoAllow?: boolean;
  /**
   * Whether a call may ask to run outside the sandbox with `dangerouslyDisableSandbox`. Such a
   * call always goes through the normal permission flow. Default false: the flag is ignored and
   * the command runs sandboxed
   */
  allowUnsandboxed?: boolean;
  /**
   * Commands that run outside the sandbox, in the pattern syntax of a `Bash(...)` rule
   * (`docker *`). Every command of a command line must match, and lines with a redirection, a
   * `cd`, a substitution or a program from a variable stay sandboxed. They go through the
   * normal permission flow
   */
  excludedCommands?: readonly string[];
  /**
   * Violations not reported: keys are substrings of the command (`*` for every command), values
   * substrings of the violation, such as a path. The sandbox still blocks them
   */
  ignoreViolations?: Readonly<Record<string, readonly string[]>>;
  filesystem?: OsSandboxFilesystemPolicy;
  network?: OsSandboxNetworkPolicy;
  credentials?: OsSandboxCredentialsPolicy;
  /** Linux: the `bwrap` binary to use instead of the one on `PATH` (an absolute path) */
  bwrapPath?: string;
  /** Linux: the `socat` binary to use instead of the one on `PATH` (an absolute path) */
  socatPath?: string;
}

/** Whether the OS sandbox can run here, and why not */
export type OsSandboxAvailability =
  | { available: true; kind: OsSandboxKind }
  | { available: false; kind?: OsSandboxKind; reason: string };

/**
 * Something the sandbox refused a command, as the command's result reports it. Network
 * violations come from the sandbox's proxy and are authoritative. Filesystem violations are
 * advisory: they are read from the errors the command wrote to stderr, so a command can hide
 * them (`2>/dev/null`) or print lines that look like them. The sandbox blocks the access either
 * way, so never base a security decision on them
 */
export interface SandboxViolation {
  /** A connection the proxy refused, or a file access the operating system refused (advisory) */
  kind: 'network' | 'filesystem';
  /** What was attempted: `network-outbound`, `file-write`, `file-read` */
  operation: string;
  /** The host and port, or the path */
  target: string;
  /** Why, in words the model reads */
  reason: string;
}

/** A connection a sandboxed command opens to a host no list decides */
export interface SandboxHostRequest {
  /** The host as the command named it, lowercase, an IPv6 address without brackets */
  host: string;
  port: number;
  /** The command that opens it */
  command: string;
}

/** Decides a host no list decides: true lets the connection through. Absent means refused */
export type SandboxHostDecider = (request: SandboxHostRequest) => Promise<boolean>;

/**
 * How a command would run: inside the sandbox, or outside it because it matches
 * `excludedCommands` (`excluded`), its call asked so and the policy allows it (`requested`), or
 * the sandbox cannot run here and the policy lets commands run anyway (`unavailable`)
 */
export type WorkspaceSandboxRoute =
  { sandboxed: true } | { sandboxed: false; reason: 'excluded' | 'requested' | 'unavailable' };

/** What a call of a command asks of the sandbox */
export interface WorkspaceSandboxRequest {
  /** Run outside the sandbox, honored only when the policy has `allowUnsandboxed` */
  dangerouslyDisableSandbox?: boolean;
}

/**
 * The OS sandbox a workspace runs its commands in (`Workspace.sandbox`), as the permission
 * engine sees it: a command that runs inside skips the approval it would need (`autoAllow`)
 */
export interface WorkspaceSandbox {
  readonly kind: OsSandboxKind;
  /** Whether sandboxed commands skip the approval a command would need, see `OsSandboxPolicy.autoAllow` */
  readonly autoAllow: boolean;
  /** Whether a call may name hosts of its own (`WorkspaceExecOptions.allowedDomains`) */
  readonly acceptsCommandDomains: boolean;
  /** How `command` would run, once the sandbox knows whether it runs on this machine */
  route(command: string, request?: WorkspaceSandboxRequest): Promise<WorkspaceSandboxRoute>;
}

/** How a command ran with respect to the sandbox, in `WorkspaceExecResult.sandbox` */
export interface WorkspaceExecSandbox {
  sandboxed: boolean;
  kind?: OsSandboxKind;
  /** Why it ran outside, see {@link WorkspaceSandboxRoute} */
  unsandboxedReason?: 'excluded' | 'requested' | 'unavailable';
  /** What the sandbox refused it, reported also in a `<sandbox_violations>` block of `stderr` */
  violations: SandboxViolation[];
}
