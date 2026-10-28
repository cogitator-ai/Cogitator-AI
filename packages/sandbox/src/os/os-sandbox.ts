import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CogitatorError,
  ErrorCode,
  WorkspaceError,
  type OsSandboxKind,
  type OsSandboxPolicy,
  type SandboxHostDecider,
  type SandboxViolation,
  type WorkspaceCommandSandbox,
  type WorkspaceExecResult,
  type WorkspaceLaunch,
  type WorkspaceLaunchOverride,
  type WorkspaceLaunchReport,
  type WorkspaceSandboxRequest,
  type WorkspaceSandboxRoute,
} from '@cogitator-ai/types';
import {
  BRIDGE_PORT,
  bubblewrapCommand,
  type BubblewrapCommand,
  type BubblewrapPath,
} from './bubblewrap';
import { isExcludedCommand } from './commands';
import { parseDomainList, type DomainPattern } from './domains';
import {
  canonicalPath,
  depthOf,
  expandWildcard,
  globRegExp,
  globSource,
  isWithin,
  kindOf,
  namesOf,
  resolvePolicyPath,
  type PolicyPath,
} from './paths';
import { probeOsSandbox, type OsSandboxProbe } from './probe';
import { protectedPaths } from './protected-paths';
import { seccompArch, seccompFilter } from './seccomp';
import { ProxySession, type ProxyRules } from './proxy';
import { seatbeltLaunch, seatbeltProfile, type SeatbeltMatcher } from './seatbelt';
import {
  fileViolations,
  neutralizeViolationTags,
  violationsBlock,
  withoutIgnored,
} from './violations';

export interface OsSandboxOptions {
  /** What commands may read, write and reach (default: the defaults of {@link OsSandboxPolicy}) */
  policy?: OsSandboxPolicy;
  /**
   * Decides a host no list decides, for commands whose call brings no decider of its own
   * (`WorkspaceExecOptions.onUnknownHost`). Without either such a host is refused
   */
  onUnknownHost?: SandboxHostDecider;
  /** Hears what the sandbox warns about: entries it cannot read, commands it runs without itself */
  onWarning?: (message: string) => void;
  /** The platform to sandbox for (default: this one), for tests of the generated profiles */
  platform?: NodeJS.Platform;
}

/**
 * The sandbox's own directories: the one each command's `TMPDIR` is made in (a directory of its
 * own, removed once the command is over), the proxy sockets, an empty one
 */
interface SandboxDirs {
  base: string;
  tmp: string;
  sockets: string;
  empty: string;
}

const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'FTP_PROXY',
  'GRPC_PROXY',
  'RSYNC_PROXY',
];

/** The plan of one sandboxed launch: what to spawn and what the filesystem rules are */
interface Restrictions {
  writable: PolicyPath[];
  /**
   * With whether a missing protected path would be a directory, and whether only the entry itself
   * is protected (see `ProtectedPath.entryOnly`)
   */
  denyWrite: Array<PolicyPath & { directory?: boolean; entryOnly?: boolean; watched?: boolean }>;
  denyRead: PolicyPath[];
  allowRead: PolicyPath[];
}

/**
 * The operating system sandbox of local commands: Seatbelt (`sandbox-exec`) on macOS,
 * bubblewrap (`bwrap`, with `socat`) on Linux, with the semantics of Claude Code's sandbox.
 *
 * A command may write in the workspace root, `filesystem.allowWrite` and a temporary directory
 * for that command alone (its `TMPDIR`, removed once it is over), never in the protected paths
 * (settings, hooks and plugins of Cogitator and Claude Code, `.cogitator` of the root, shell
 * startup files, `.gitconfig`, the files of the repository's git directory that git would run or
 * follow, the `.git` entry itself, files that would turn the root into a bare repository), and
 * may read everywhere but `filesystem.denyRead`, the narrower of a deny and an
 * allow winning. It has no network but the sandbox's proxy, an HTTP and SOCKS5 proxy for that
 * command alone, which lets through the hosts `network.allowedDomains` names, refuses
 * `network.deniedDomains`, and asks `onUnknownHost` (of the call, else of the sandbox) about the
 * rest. A host name that resolves only to this machine is refused, `localhost` aside.
 *
 * Give it to a `LocalWorkspace` as `exec.sandbox`: the workspace then runs its commands through
 * it, and the permission engine lets a command that runs inside skip its approval
 * (`policy.autoAllow`). When the sandbox cannot run on the machine it refuses to start
 * (`SANDBOX_UNAVAILABLE`) unless `policy.failIfUnavailable` is false. A command never runs
 * unprotected without its result saying so.
 *
 * @example
 * ```ts
 * const sandbox = new OsSandbox({ policy: { network: { allowedDomains: ['registry.npmjs.org'] } } });
 * const workspace = new LocalWorkspace({ root: './project', exec: { sandbox } });
 * await workspace.start();
 * ```
 */
export class OsSandbox implements WorkspaceCommandSandbox {
  readonly kind: OsSandboxKind;
  readonly autoAllow: boolean;
  readonly acceptsCommandDomains: boolean;
  /** Problems with the policy found when it was read: entries left out */
  readonly warnings: readonly string[];
  private readonly policy: OsSandboxPolicy;
  private readonly platform: NodeJS.Platform;
  private readonly rules: ProxyRules;
  private readonly failIfUnavailable: boolean;
  private readonly onUnknownHost?: SandboxHostDecider;
  private readonly warn: (message: string) => void;
  private readonly sessions = new Set<ProxySession>();
  private probing?: Promise<OsSandboxProbe>;
  private directories?: Promise<SandboxDirs>;
  private warnedUnavailable = false;
  private readonly warned = new Set<string>();
  private disposed = false;

  constructor(options: OsSandboxOptions = {}) {
    const policy = options.policy ?? {};
    if (policy.enabled === false) {
      throw new RangeError('The sandbox policy is disabled (enabled: false): create no OsSandbox');
    }
    this.policy = policy;
    this.platform = options.platform ?? process.platform;
    this.kind = this.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
    this.autoAllow = policy.autoAllow ?? true;
    this.failIfUnavailable = policy.failIfUnavailable ?? true;
    this.onUnknownHost = options.onUnknownHost;
    this.warn = options.onWarning ?? ((message) => console.warn(`[sandbox] ${message}`));
    const allowed = parseDomainList(policy.network?.allowedDomains ?? [], 'allow');
    const denied = parseDomainList(policy.network?.deniedDomains ?? [], 'deny');
    this.rules = {
      allowed: allowed.patterns,
      denied: denied.patterns,
      strict: policy.network?.strictAllowlist === true,
    };
    this.acceptsCommandDomains = !this.rules.strict;
    this.warnings = [...allowed.warnings, ...denied.warnings];
    for (const warning of this.warnings) this.warn(warning);
  }

  /** Whether the OS sandbox runs on this machine, and why not */
  static probe(
    options: {
      platform?: NodeJS.Platform;
      bwrapPath?: string;
      socatPath?: string;
      allowAllUnixSockets?: boolean;
    } = {}
  ): Promise<OsSandboxProbe> {
    return probeOsSandbox(options);
  }

  /** A sandbox for `options`, started: it fails here when the sandbox cannot run, see {@link start} */
  static async create(options: OsSandboxOptions = {}): Promise<OsSandbox> {
    const sandbox = new OsSandbox(options);
    await sandbox.start();
    return sandbox;
  }

  /** Whether the sandbox runs here, probed once */
  availability(): Promise<OsSandboxProbe> {
    this.probing ??= probeOsSandbox({
      platform: this.platform,
      ...(this.policy.bwrapPath !== undefined && { bwrapPath: this.policy.bwrapPath }),
      ...(this.policy.socatPath !== undefined && { socatPath: this.policy.socatPath }),
      allowAllUnixSockets: this.policy.network?.allowAllUnixSockets === true,
    });
    return this.probing;
  }

  /**
   * Checks that the sandbox runs on this machine
   *
   * @throws CogitatorError `SANDBOX_UNAVAILABLE` with the reason, when it does not and the policy
   * does not let commands run without it (`failIfUnavailable`, default true)
   */
  async start(): Promise<void> {
    const probe = await this.availability();
    if (probe.available) return;
    if (this.failIfUnavailable) throw unavailableError(probe.reason);
    this.warnUnavailable(probe.reason);
  }

  async route(
    command: string,
    request: WorkspaceSandboxRequest = {}
  ): Promise<WorkspaceSandboxRoute> {
    const probe = await this.availability();
    if (!probe.available && !this.failIfUnavailable) {
      return { sandboxed: false, reason: 'unavailable' };
    }
    if (isExcludedCommand(command, this.policy.excludedCommands ?? [])) {
      return { sandboxed: false, reason: 'excluded' };
    }
    if (request.dangerouslyDisableSandbox === true && this.policy.allowUnsandboxed === true) {
      return { sandboxed: false, reason: 'requested' };
    }
    return { sandboxed: true };
  }

  /**
   * What to spawn for a command of a workspace: the command under the sandbox with the proxy
   * variables and `TMPDIR` set, or as it is when it runs outside, with a cleanup that closes its
   * proxy and reports what was refused
   */
  async launch(launch: WorkspaceLaunch): Promise<WorkspaceLaunchOverride> {
    if (this.disposed) throw new WorkspaceError('DISPOSED', 'The OS sandbox is disposed');
    const route = await this.route(launch.command, launch.request);
    if (!route.sandboxed) {
      const probe = await this.availability();
      if (!probe.available) this.warnUnavailable(probe.reason);
      return {
        file: launch.file,
        args: launch.args,
        cleanup: (): WorkspaceLaunchReport => ({
          sandbox: {
            sandboxed: false,
            kind: this.kind,
            unsandboxedReason: route.reason,
            violations: [],
          },
        }),
      };
    }
    const probe = await this.availability();
    if (!probe.available) throw unavailableError(probe.reason);
    const commandAllowed = this.commandDomains(launch.request.allowedDomains);
    const dirs = await this.dirs();
    const decide = launch.request.onUnknownHost ?? this.onUnknownHost;
    const session = await ProxySession.start({
      command: launch.command,
      rules: this.rules,
      ...(commandAllowed && { commandAllowed }),
      ...(decide && { decide }),
      listen:
        this.kind === 'seatbelt'
          ? { tcp: true }
          : { path: join(dirs.sockets, `${randomUUID().slice(0, 12)}.sock`) },
    });
    this.sessions.add(session);
    let mountPoints: string[] = [];
    let extraInputs: Uint8Array[] | undefined;
    let watched: string[] = [];
    let tmp: string | undefined;
    try {
      tmp = join(dirs.tmp, randomUUID().slice(0, 12));
      await mkdir(tmp, { mode: 0o700 });
      const { launcher: env, loader } = splitLoaderEnvironment(
        this.environment(launch.env, tmp, session)
      );
      const restrictions = await this.restrictions(launch.root, tmp);
      let spawned: { file: string; args: string[] };
      if (this.kind === 'seatbelt') {
        spawned = seatbeltLaunch(
          seatbeltProfile({
            writable: await this.matchers(restrictions.writable, 'write-allow'),
            denyWrite: await this.matchers(restrictions.denyWrite, 'deny'),
            read: [
              ...(await this.matchers(restrictions.denyRead, 'deny')).map((matcher) => ({
                matcher,
                allow: false,
              })),
              ...(await this.matchers(restrictions.allowRead, 'deny')).map((matcher) => ({
                matcher,
                allow: true,
              })),
            ],
            filesystemDisabled: this.policy.filesystem?.disabled === true,
            proxyPort: session.port,
            allowLocalBinding: this.policy.network?.allowLocalBinding === true,
            unixSockets: await Promise.all(
              (this.policy.network?.allowUnixSockets ?? []).map(async (path) =>
                canonicalPath(resolvePolicyPath(path, launch.root).path)
              )
            ),
            allUnixSockets: this.policy.network?.allowAllUnixSockets === true,
          }),
          launch.file,
          launch.args
        );
      } else {
        const linux = await this.bubblewrap(launch, restrictions, dirs, probe, session, loader);
        mountPoints = linux.mountPoints;
        watched = linux.watched;
        spawned = { file: linux.file, args: linux.args };
        if (linux.extraInputs.length > 0) extraInputs = linux.extraInputs;
      }
      return {
        ...spawned,
        env,
        ...(extraInputs && { extraInputs }),
        cleanup: (result) =>
          this.finish(session, launch.command, mountPoints, watched, tmp, result),
      };
    } catch (error) {
      this.sessions.delete(session);
      await session.close();
      if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Closes the proxies of commands still running and removes the sandbox's directories */
  async dispose(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
    const dirs = await this.directories?.catch(() => undefined);
    if (dirs) {
      await chmod(dirs.empty, 0o700).catch(() => undefined);
      await rm(dirs.base, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message);
  }

  private warnUnavailable(reason: string): void {
    if (this.warnedUnavailable) return;
    this.warnedUnavailable = true;
    this.warn(
      `The OS sandbox cannot run here (${reason}): commands run UNSANDBOXED because the policy sets failIfUnavailable: false`
    );
  }

  private commandDomains(entries: readonly string[] | undefined): DomainPattern[] | undefined {
    if (!entries || entries.length === 0) return undefined;
    if (!this.acceptsCommandDomains) {
      throw new WorkspaceError(
        'DENIED',
        'The sandbox policy has strictAllowlist: a command cannot name hosts of its own (allowedDomains)'
      );
    }
    const list = parseDomainList(entries, 'allow');
    if (list.warnings.length > 0) {
      throw new WorkspaceError(
        'DENIED',
        `The hosts the command lists: ${list.warnings.join(', ')}`
      );
    }
    return list.patterns;
  }

  private dirs(): Promise<SandboxDirs> {
    this.directories ??= (async () => {
      const base = await mkdtemp(join(await realpath(tmpdir()), 'cogitator-sandbox-'));
      await chmod(base, 0o700);
      const dirs = {
        base,
        tmp: join(base, 'tmp'),
        sockets: join(base, 'sockets'),
        empty: join(base, 'empty'),
      };
      await mkdir(dirs.tmp, { mode: 0o700 });
      await mkdir(dirs.sockets, { mode: 0o700 });
      await mkdir(dirs.empty, { mode: 0o500 });
      return dirs;
    })();
    this.directories.catch(() => {
      this.directories = undefined;
    });
    return this.directories;
  }

  private environment(
    given: Record<string, string>,
    tmp: string,
    session: ProxySession
  ): Record<string, string> {
    const env = { ...given };
    for (const name of PROXY_VARIABLES) {
      delete env[name];
      delete env[name.toLowerCase()];
    }
    for (const name of this.policy.credentials?.envVars ?? []) delete env[name];
    const proxy =
      this.kind === 'seatbelt' ? `127.0.0.1:${session.port}` : `127.0.0.1:${BRIDGE_PORT}`;
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'GRPC_PROXY']) {
      env[name] = `http://${proxy}`;
      env[name.toLowerCase()] = `http://${proxy}`;
    }
    env.ALL_PROXY = `socks5h://${proxy}`;
    env.all_proxy = `socks5h://${proxy}`;
    env.RSYNC_PROXY = proxy;
    if (this.kind === 'seatbelt' && this.policy.network?.allowLocalBinding === true) {
      env.NO_PROXY = 'localhost,127.0.0.1,::1';
      env.no_proxy = env.NO_PROXY;
    }
    if (this.policy.filesystem?.disabled !== true) {
      env.TMPDIR = tmp;
      env.TMP = tmp;
      env.TEMP = tmp;
    }
    env.COGITATOR_SANDBOX = this.kind;
    return env;
  }

  /** The filesystem lists of a launch in the workspace at `root`, resolved */
  private async restrictions(root: string, tmp: string): Promise<Restrictions> {
    const fs = this.policy.filesystem ?? {};
    const resolveAll = (entries: readonly string[] | undefined) =>
      (entries ?? []).map((entry) => resolvePolicyPath(entry, root));
    const protectedList =
      fs.disabled === true
        ? []
        : (await protectedPaths(root)).map((entry) => ({
            entry: entry.path,
            path: entry.path,
            directory: entry.directory,
            ...(entry.entryOnly && { entryOnly: true }),
            ...(entry.watched && { watched: true }),
          }));
    const denyRead = [...resolveAll(fs.denyRead), ...resolveAll(this.policy.credentials?.files)];
    const allowRead: PolicyPath[] = [];
    for (const entry of resolveAll(fs.allowRead)) {
      if (await reopensThroughLink(entry.base ?? entry.path, denyRead)) {
        this.warnOnce(
          `allowRead ${entry.entry}: it reaches into a denyRead region only through a symlink, it is ignored`
        );
        continue;
      }
      allowRead.push(entry);
    }
    return {
      writable: [
        { entry: '.', path: root },
        { entry: 'TMPDIR', path: tmp },
        ...resolveAll(fs.allowWrite),
      ],
      denyWrite: [...resolveAll(fs.denyWrite), ...protectedList],
      denyRead,
      allowRead,
    };
  }

  /**
   * Seatbelt filters for entries: a wildcard entry as an expression over the real path of its
   * base, a path as a subpath under each name it has (as written and where its symlinks lead)
   */
  private async matchers(
    entries: ReadonlyArray<PolicyPath & { entryOnly?: boolean }>,
    use: 'write-allow' | 'deny'
  ): Promise<SeatbeltMatcher[]> {
    const out: SeatbeltMatcher[] = [];
    for (const entry of entries) {
      if (entry.pattern && entry.base) {
        const base = await canonicalPath(entry.base);
        const rest = entry.path.slice(entry.base.length);
        const names = rest.split('/').filter((part) => part !== '' && part !== '**').length;
        out.push({
          kind: 'regex',
          source: `^${globSource(base + rest, 'posix')}(/.*)?$`,
          depth: depthOf(base) + names,
        });
        continue;
      }
      const names = use === 'deny' ? await namesOf(entry.path) : [await canonicalPath(entry.path)];
      for (const path of names) out.push({ kind: entry.entryOnly ? 'literal' : 'subpath', path });
    }
    return out;
  }

  private async bubblewrap(
    launch: WorkspaceLaunch,
    restrictions: Restrictions,
    dirs: SandboxDirs,
    probe: OsSandboxProbe,
    session: ProxySession,
    commandEnv: Readonly<Record<string, string>>
  ): Promise<BubblewrapCommand & { watched: string[] }> {
    const writable: string[] = [];
    for (const entry of restrictions.writable) {
      if (entry.pattern) {
        this.warn(`allowWrite ${entry.entry}: wildcards are not supported on Linux, it is skipped`);
        continue;
      }
      const real = await canonicalPath(entry.path);
      if (await kindOf(real)) writable.push(real);
    }
    const denyWrite: BubblewrapPath[] = [];
    const watched: string[] = [];
    for (const entry of restrictions.denyWrite) {
      const paths = entry.pattern
        ? (await expandWildcard(entry)).matches
        : await namesOf(entry.path);
      for (const path of paths) {
        if (denyWrite.some((known) => known.path === path) || (await throughSymlink(path))) {
          continue;
        }
        const kind = await kindOf(path);
        if (entry.watched && kind === undefined) {
          watched.push(path);
          continue;
        }
        denyWrite.push({
          path,
          exists: kind !== undefined,
          directory: kind === undefined ? entry.directory === true : kind === 'directory',
          ...(kind === 'symlink' && { real: await canonicalPath(path) }),
          ...(entry.entryOnly && { entryOnly: true }),
        });
      }
    }
    const denyRead: BubblewrapPath[] = [];
    for (const entry of restrictions.denyRead) {
      let paths: string[];
      if (entry.pattern) {
        const expanded = await expandWildcard(entry);
        if (expanded.truncated && entry.base) {
          this.warn(
            `denyRead ${entry.entry}: too many entries to expand, all of ${entry.base} is denied`
          );
          paths = [entry.base];
        } else {
          paths = expanded.matches;
        }
      } else {
        paths = await namesOf(entry.path);
      }
      for (const path of paths) {
        if (await throughSymlink(path)) continue;
        const kind = await kindOf(path);
        if (kind === undefined) continue;
        const real = kind === 'symlink' ? await canonicalPath(path) : path;
        const realKind = await kindOf(real);
        if (realKind === undefined) continue;
        denyRead.push({ path: real, exists: true, directory: realKind === 'directory' });
      }
    }
    const allowRead: string[] = [];
    for (const entry of restrictions.allowRead) {
      const paths = entry.pattern ? (await expandWildcard(entry)).matches : [entry.path];
      for (const path of paths) {
        if (entry.pattern && (await reopensThroughLink(path, restrictions.denyRead))) continue;
        const real = await canonicalPath(path);
        if (await kindOf(real)) allowRead.push(real);
      }
    }
    const existing = new Set<string>();
    for (const entry of denyWrite) {
      if (entry.exists) continue;
      const parts = entry.path.split('/');
      for (let i = 2; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (await kindOf(prefix)) existing.add(prefix);
      }
    }
    const nesting = probe.nesting;
    if (!nesting) throw unavailableError('bwrap was not checked for its nesting protections');
    const network = this.policy.network ?? {};
    const unixSockets =
      network.allowAllUnixSockets === true || (network.allowUnixSockets ?? []).length > 0;
    if ((network.allowUnixSockets ?? []).length > 0 && network.allowAllUnixSockets !== true) {
      this.warnOnce(
        'allowUnixSockets: on Linux the seccomp filter cannot tell socket paths apart, so commands may create every Unix socket'
      );
    }
    const arch = seccompArch();
    if (nesting.seccomp && !arch)
      throw unavailableError(`no seccomp filter for the ${process.arch} CPU`);
    const command = bubblewrapCommand(
      {
        bwrap: probe.bwrap ?? 'bwrap',
        disableUserns: nesting.disableUserns,
        ...(nesting.seccomp &&
          arch && { seccomp: seccompFilter({ arch, allowUnixSockets: unixSockets }) }),
        socat: probe.socat ?? 'socat',
        writable,
        denyWrite,
        denyRead,
        allowRead,
        filesystemDisabled: this.policy.filesystem?.disabled === true,
        proxySocket: sessionSocket(session, dirs),
        emptyDir: dirs.empty,
        cwd: launch.cwd,
        file: launch.file,
        args: launch.args,
        commandEnv,
      },
      (path) => existing.has(path)
    );
    return { ...command, watched };
  }

  private async finish(
    session: ProxySession,
    command: string,
    mountPoints: readonly string[],
    watched: readonly string[],
    tmp: string | undefined,
    result: WorkspaceExecResult | undefined
  ): Promise<WorkspaceLaunchReport> {
    this.sessions.delete(session);
    await session.close();
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    for (const point of mountPoints) await removeMountPoint(point);
    for (const path of watched)
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    const found: SandboxViolation[] = [
      ...session.violations,
      ...(result ? fileViolations(result.stderr) : []),
    ];
    const violations = withoutIgnored(found, command, this.policy.ignoreViolations);
    const notice = violationsBlock(violations);
    return {
      sandbox: { sandboxed: true, kind: this.kind, violations },
      ...(notice && { notice }),
      ...(result && {
        output: {
          stdout: neutralizeViolationTags(result.stdout),
          stderr: neutralizeViolationTags(result.stderr),
        },
      }),
    };
  }
}

/**
 * Whether a directory above `path` is a symlink. Bubblewrap cannot mount there (the link may lead
 * anywhere once the new root is set up), and the same path with its parent resolved is on the
 * list as well
 */
async function throughSymlink(path: string): Promise<boolean> {
  return (await canonicalPath(dirname(path))) !== dirname(path);
}

/** The socket path a Linux session listens on */
function sessionSocket(session: ProxySession, dirs: SandboxDirs): string {
  const path = session.socketPath;
  if (!path) {
    throw new Error(`The proxy of a bubblewrap command listens on no socket in ${dirs.sockets}`);
  }
  return path;
}

/** Removes a mount point bubblewrap left on the host: an empty file or an empty directory */
async function removeMountPoint(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return;
  if (info.isFile() && info.size === 0) {
    await unlink(path).catch(() => undefined);
    return;
  }
  if (info.isDirectory() && (await readdir(path).catch(() => ['?'])).length === 0) {
    await rmdir(path).catch(() => undefined);
  }
}

function unavailableError(reason: string): CogitatorError {
  return new CogitatorError({
    message: `The OS sandbox cannot run here: ${reason}`,
    code: ErrorCode.SANDBOX_UNAVAILABLE,
    details: { reason, platform: process.platform },
  });
}

/**
 * Whether reading `written` is allowed again only because a symlink on the way leads into a
 * `denyRead` region the path as written lies outside of. An `allowRead` reopens a denied region
 * only by naming a path inside it, so a symlink made before the launch, or by an earlier command
 * in a writable directory, never reopens a deny no entry names
 */
async function reopensThroughLink(
  written: string,
  denyRead: readonly PolicyPath[]
): Promise<boolean> {
  const real = await canonicalPath(written);
  for (const deny of denyRead) {
    let covers: (path: string) => boolean;
    let coversReal: (path: string) => boolean;
    if (deny.pattern && deny.base) {
      const pattern = deny.pattern;
      const realPattern = globRegExp(
        (await canonicalPath(deny.base)) + deny.path.slice(deny.base.length)
      );
      covers = (path) => pattern.test(path);
      coversReal = (path) => realPattern.test(path) || pattern.test(path);
    } else {
      const deniedReal = await canonicalPath(deny.path);
      covers = (path) => isWithin(deny.path, path);
      coversReal = (path) => isWithin(deniedReal, path) || isWithin(deny.path, path);
    }
    if (coversReal(real) && !covers(written) && !coversReal(written)) return true;
  }
  return false;
}

/**
 * Variables that make the dynamic loader run code of the caller's choosing (`LD_PRELOAD`,
 * `LD_LIBRARY_PATH`, `LD_AUDIT`, the `DYLD_` ones of macOS) or glibc load modules (`GCONV_PATH`)
 */
const LOADER_VARIABLE = /^(LD_|DYLD_)|^GCONV_PATH$/;

/**
 * The environment of the launcher (`bwrap`, `sandbox-exec` and what runs before the command)
 * without the loader variables, which would run code before any restriction holds, and those
 * variables apart: bubblewrap hands them to the command alone, `sandbox-exec` (a system binary
 * the loader drops them for anyway) to none
 */
function splitLoaderEnvironment(env: Record<string, string>): {
  launcher: Record<string, string>;
  loader: Record<string, string>;
} {
  const launcher: Record<string, string> = {};
  const loader: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    (LOADER_VARIABLE.test(name) ? loader : launcher)[name] = value;
  }
  return { launcher, loader };
}
