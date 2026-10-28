/**
 * The Seatbelt profile a command runs under on macOS (`sandbox-exec -p`): everything denied by
 * default, the operations a shell and the usual tools need allowed, reads everywhere but the
 * denied paths, writes only in the writable roots, and network only to the proxy on loopback
 */

import { depthOf } from './paths';

/** The program that applies a profile */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * A path a rule of the profile names: one path, a directory and what it holds, or an expression
 * (POSIX extended syntax, over absolute paths) with how many names its glob spells (`**` counts
 * none), which ranks it against the other read rules
 */
export type SeatbeltMatcher =
  | { kind: 'literal'; path: string }
  | { kind: 'subpath'; path: string }
  | { kind: 'regex'; source: string; depth: number; base?: string };

export interface SeatbeltProfileInput {
  /** Where commands may write: the workspace root, `allowWrite`, the sandbox's `TMPDIR` */
  writable: readonly SeatbeltMatcher[];
  /** Where they may not, even inside a writable root: `denyWrite` and the protected paths */
  denyWrite: readonly SeatbeltMatcher[];
  /** `denyRead` and `allowRead`, the narrower rule winning */
  read: readonly { matcher: SeatbeltMatcher; allow: boolean }[];
  /** No filesystem rules at all: read and write everywhere */
  filesystemDisabled: boolean;
  /** The loopback port of the proxy, the only connection allowed out */
  proxyPort?: number;
  allowLocalBinding: boolean;
  unixSockets: readonly string[];
  allUnixSockets: boolean;
}

/** Mach services a sandboxed process may look up: logging, user and group lookups, fonts, keychain reads */
const MACH_SERVICES = [
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.bsd.dirhelper',
  'com.apple.logd',
  'com.apple.diagnosticd',
  'com.apple.SecurityServer',
  'com.apple.lsd.mapdb',
  'com.apple.FontObjectsServer',
  'com.apple.fonts',
  'com.apple.PowerManagement.control',
  'com.apple.audio.systemsoundserver',
  'com.apple.distributed_notifications@Uv3',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
];

/** Device files commands may write: discarding output, terminals, the descriptors of the process */
const WRITABLE_DEVICES = [
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/tty")',
  '(literal "/dev/dtracehelper")',
  '(literal "/dev/stdout")',
  '(literal "/dev/stderr")',
  '(subpath "/dev/fd")',
];

/** `text` as a string literal of the profile language */
export function sbString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function filter(matcher: SeatbeltMatcher): string {
  switch (matcher.kind) {
    case 'literal':
      return `(literal ${sbString(matcher.path)})`;
    case 'subpath':
      return `(subpath ${sbString(matcher.path)})`;
    case 'regex':
      return `(regex ${sbString(matcher.source)})`;
  }
}

/**
 * How specific a read rule is: by the names its path spells, a wildcard name counting as one and
 * `**` as none, a deny after an allow on a tie. Seatbelt applies the last rule that matches, so
 * the rules are written from the least specific to the most: a `denyRead` inside a wider
 * `allowRead` holds, an `allowRead` inside a wider `denyRead` reopens
 */
function specificity(rule: { matcher: SeatbeltMatcher; allow: boolean }): number {
  const depth = rule.matcher.kind === 'regex' ? rule.matcher.depth : depthOf(rule.matcher.path);
  return depth * 2 + (rule.allow ? 0 : 1);
}

/**
 * The filters that keep the paths of `matchers` where they are: each path itself and every
 * directory above it may not be renamed or removed. Seatbelt judges an access by the path it
 * goes through, so a command that moved a protected file's directory elsewhere could write the
 * file under its new name, and one that moved a denied directory could read it there. What a
 * denied directory holds is kept in place by the depth-ordered unlink rules before these
 */
function moveBlocking(matchers: readonly SeatbeltMatcher[]): string[] {
  const filters = new Set<string>();
  for (const matcher of matchers) {
    filters.add(
      filter(matcher.kind === 'subpath' ? { kind: 'literal', path: matcher.path } : matcher)
    );
    const path = matcher.kind === 'regex' ? matcher.base : matcher.path;
    if (path === undefined) continue;
    for (let dir = path; dir !== '/' && dir.includes('/');) {
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
      if (dir !== '/') filters.add(filter({ kind: 'literal', path: dir }));
    }
  }
  return [...filters];
}

/** The profile for `input` */
export function seatbeltProfile(input: SeatbeltProfileInput): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow mach-priv-task-port (target same-sandbox))',
    '(allow user-preference-read)',
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${sbString(name)})`).join(' ')})`,
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow iokit-get-properties)',
    '(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient") (iokit-user-client-class "IOSurfaceSendRight"))',
    '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
    '(allow sysctl-read)',
    '(allow distributed-notification-post)',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
    '(allow file-read*)',
  ];

  if (input.filesystemDisabled) {
    lines.push('(allow file-write*)');
  } else {
    const ordered = [...input.read].sort((a, b) => specificity(a) - specificity(b));
    for (const rule of ordered) {
      lines.push(`(${rule.allow ? 'allow' : 'deny'} file-read* ${filter(rule.matcher)})`);
    }
    lines.push(`(allow file-write* ${WRITABLE_DEVICES.join(' ')})`);
    if (input.writable.length > 0) {
      lines.push(`(allow file-write* ${input.writable.map(filter).join(' ')})`);
    }
    const denyRead = input.read.filter((rule) => !rule.allow).map((rule) => rule.matcher);
    if (denyRead.length > 0) {
      const unlinkRules = [
        ...denyRead.map((matcher) => ({ matcher, allow: false })),
        ...input.writable.map((matcher) => ({ matcher, allow: true })),
      ].sort((a, b) => specificity(a) - specificity(b));
      for (const rule of unlinkRules) {
        lines.push(`(${rule.allow ? 'allow' : 'deny'} file-write-unlink ${filter(rule.matcher)})`);
      }
    }
    if (input.denyWrite.length > 0) {
      lines.push(`(deny file-write* ${input.denyWrite.map(filter).join(' ')})`);
    }
    const unmovable = moveBlocking([...input.denyWrite, ...denyRead]);
    if (unmovable.length > 0) lines.push(`(deny file-write-unlink ${unmovable.join(' ')})`);
  }

  if (input.proxyPort !== undefined) {
    lines.push(`(allow network-outbound (remote ip ${sbString(`localhost:${input.proxyPort}`)}))`);
  }
  if (input.allowLocalBinding) {
    lines.push('(allow network-bind (local ip "localhost:*"))');
    lines.push('(allow network-inbound (local ip "localhost:*"))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
  }
  if (input.allUnixSockets) {
    lines.push('(allow network* (remote unix-socket))');
    lines.push('(allow network-bind (local unix-socket))');
  } else if (input.unixSockets.length > 0) {
    const paths = input.unixSockets.map((path) => `(path-literal ${sbString(path)})`).join(' ');
    lines.push(`(allow network-outbound (remote unix-socket ${paths}))`);
  }
  return `${lines.join('\n')}\n`;
}

/** What to spawn to run `file args` under `profile` */
export function seatbeltLaunch(
  profile: string,
  file: string,
  args: readonly string[]
): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ['-p', profile, file, ...args] };
}
