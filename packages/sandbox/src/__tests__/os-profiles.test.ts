import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRIDGE_PORT, bridgeScript, bubblewrapCommand } from '../os/bubblewrap';
import { protectedPaths } from '../os/protected-paths';
import { SANDBOX_EXEC, sbString, seatbeltLaunch, seatbeltProfile } from '../os/seatbelt';

describe('seatbeltProfile', () => {
  const base = {
    writable: [{ kind: 'subpath' as const, path: '/w' }],
    denyWrite: [{ kind: 'subpath' as const, path: '/w/.git/hooks' }],
    read: [],
    filesystemDisabled: false,
    proxyPort: 41234,
    allowLocalBinding: false,
    unixSockets: [],
    allUnixSockets: false,
  };

  it('denies by default and allows writes only in the writable roots, the denies after them', () => {
    const profile = seatbeltProfile(base);
    const lines = profile.trim().split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(deny default)');
    const allow = lines.indexOf('(allow file-write* (subpath "/w"))');
    const deny = lines.indexOf('(deny file-write* (subpath "/w/.git/hooks"))');
    expect(allow).toBeGreaterThan(0);
    expect(deny).toBeGreaterThan(allow);
    expect(profile).toContain('(allow file-read*)');
  });

  it('lets network out only to the proxy port on loopback', () => {
    const profile = seatbeltProfile(base);
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:41234"))');
    expect(profile).not.toContain('(allow network*');
    expect(profile).not.toContain('localhost:*');
  });

  it('orders read rules so the narrower wins and a deny wins a tie', () => {
    const profile = seatbeltProfile({
      ...base,
      read: [
        { matcher: { kind: 'subpath', path: '/Users/me/project' }, allow: true },
        { matcher: { kind: 'subpath', path: '/Users/me' }, allow: false },
        { matcher: { kind: 'regex', source: '^/Users/me/(.*/)?\\.env(/.*)?$' }, allow: false },
        { matcher: { kind: 'subpath', path: '/same' }, allow: false },
        { matcher: { kind: 'subpath', path: '/same' }, allow: true },
      ],
    });
    const at = (text: string) => profile.indexOf(text);
    expect(at('(deny file-read* (subpath "/Users/me"))')).toBeLessThan(
      at('(allow file-read* (subpath "/Users/me/project"))')
    );
    expect(at('(allow file-read* (subpath "/Users/me/project"))')).toBeLessThan(
      at('(deny file-read* (regex #"^/Users/me/(.*/)?\\\\.env(/.*)?$"))')
    );
    expect(at('(allow file-read* (subpath "/same"))')).toBeLessThan(
      at('(deny file-read* (subpath "/same"))')
    );
  });

  it('allows local binding and unix sockets only when the policy says so', () => {
    const open = seatbeltProfile({
      ...base,
      allowLocalBinding: true,
      unixSockets: ['/tmp/agent.sock'],
    });
    expect(open).toContain('(allow network-bind (local ip "localhost:*"))');
    expect(open).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(open).toContain(
      '(allow network-outbound (remote unix-socket (path-literal "/tmp/agent.sock")))'
    );
    expect(seatbeltProfile({ ...base, allUnixSockets: true })).toContain(
      '(allow network* (remote unix-socket))'
    );
  });

  it('writes everywhere without filesystem isolation, the network still confined', () => {
    const profile = seatbeltProfile({ ...base, filesystemDisabled: true });
    expect(profile).toContain('(allow file-write*)\n');
    expect(profile).not.toContain('(deny file-write*');
    expect(profile).toContain('(remote ip "localhost:41234")');
  });

  it('escapes quotes and backslashes in paths', () => {
    expect(sbString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
  });

  it('runs the command through sandbox-exec with the profile', () => {
    expect(seatbeltLaunch('(version 1)', '/bin/sh', ['-c', 'ls'])).toEqual({
      file: SANDBOX_EXEC,
      args: ['-p', '(version 1)', '/bin/sh', '-c', 'ls'],
    });
  });
});

describe('bubblewrapCommand', () => {
  const input = {
    bwrap: '/usr/bin/bwrap',
    socat: '/usr/bin/socat',
    writable: ['/w', '/tmp/sbx/tmp'],
    denyWrite: [
      { path: '/w/.git/hooks', directory: true, exists: true },
      { path: '/w/.bashrc', directory: false, exists: false },
      { path: '/w/.claude/settings.json', directory: false, exists: false },
      { path: '/elsewhere/x', directory: false, exists: false },
    ],
    denyRead: [
      { path: '/home/u', directory: true, exists: true },
      { path: '/w/secret.txt', directory: false, exists: true },
    ],
    allowRead: ['/home/u/project'],
    filesystemDisabled: false,
    proxySocket: '/tmp/sbx/sockets/a.sock',
    emptyDir: '/tmp/sbx/empty',
    cwd: '/w/src',
    file: '/bin/sh',
    args: ['-c', 'npm test'],
  };
  const existing = new Set(['/w', '/w/.git', '/tmp', '/tmp/sbx', '/home', '/home/u']);

  it('isolates the network and the processes, the root read-only', () => {
    const { file, args } = bubblewrapCommand(input, (path) => existing.has(path));
    expect(file).toBe('/usr/bin/bwrap');
    expect(args.slice(0, 7)).toEqual([
      '--new-session',
      '--die-with-parent',
      '--unshare-net',
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/',
    ]);
    expect(args).toContain('--dev');
    expect(args).toContain('--proc');
  });

  it('mounts in depth order: writable roots, hidden reads, reopened reads, protected paths', () => {
    const { args } = bubblewrapCommand(input, (path) => existing.has(path));
    const joined = args.join(' ');
    const at = (text: string) => joined.indexOf(text);
    expect(at('--bind /w /w')).toBeGreaterThan(0);
    expect(at('--tmpfs /home/u')).toBeLessThan(at('--ro-bind /home/u/project /home/u/project'));
    expect(at('--bind /w /w')).toBeLessThan(at('--ro-bind /w/.git/hooks /w/.git/hooks'));
    expect(joined).toContain('--ro-bind /dev/null /w/secret.txt');
  });

  it('covers missing protected paths with read-only mount points and lists them for removal', () => {
    const { args, mountPoints } = bubblewrapCommand(input, (path) => existing.has(path));
    const joined = args.join(' ');
    expect(joined).toContain('--ro-bind /dev/null /w/.bashrc');
    expect(joined).toContain('--ro-bind /tmp/sbx/empty /w/.claude');
    expect(mountPoints).toEqual(['/w/.bashrc', '/w/.claude']);
    expect(joined).not.toContain('/elsewhere/x');
  });

  it('runs the command after the bridge to the proxy socket listens', () => {
    const { args } = bubblewrapCommand(input, (path) => existing.has(path));
    const dash = args.indexOf('--');
    expect(args.slice(args.indexOf('--chdir'), dash)).toEqual(['--chdir', '/w/src']);
    expect(args.slice(dash + 1, dash + 3)).toEqual(['/bin/sh', '-c']);
    expect(args.slice(dash + 4)).toEqual(['cogitator-sandbox', '/bin/sh', '-c', 'npm test']);
    const script = args[dash + 3];
    expect(script).toBe(bridgeScript(input));
    expect(script).toContain(`TCP-LISTEN:${BRIDGE_PORT},bind=127.0.0.1,fork,reuseaddr`);
    expect(script).toContain("'UNIX-CONNECT:/tmp/sbx/sockets/a.sock'");
    expect(script.trim().endsWith('exec "$@"')).toBe(true);
    expect(joined(args)).toContain('--ro-bind /tmp/sbx/sockets /tmp/sbx/sockets');
  });

  it('binds the whole root writable without filesystem isolation', () => {
    const { args } = bubblewrapCommand({ ...input, filesystemDisabled: true }, (path) =>
      existing.has(path)
    );
    expect(args.slice(4, 7)).toEqual(['--bind', '/', '/']);
    expect(args).not.toContain('--tmpfs');
  });
});

function joined(args: string[]): string {
  return args.join(' ');
}

describe('protectedPaths', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'protected-')));
    root = join(base, 'project');
    home = join(base, 'home');
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('protects settings, hooks, shell files and git config of the root', async () => {
    const paths = (await protectedPaths(root, home)).map((entry) => entry.path);
    for (const name of [
      '.claude/settings.json',
      '.claude/hooks',
      '.mcp.json',
      '.cogitator',
      '.bashrc',
      '.zshrc',
      '.gitconfig',
      '.vscode',
      '.git/hooks',
      '.git/config',
      'HEAD',
    ]) {
      expect(paths, name).toContain(join(root, name));
    }
    expect(paths).not.toContain(join(root, 'objects'));
    expect(paths).toContain(join(home, '.claude'));
    expect(paths).toContain(join(home, '.claude.json'));
    expect(paths).toContain(join(root, '..', '.claude', 'settings.json'));
  });

  it('protects objects, refs, config and hooks once a HEAD sits in the root', async () => {
    await writeFile(join(root, 'HEAD'), 'ref: refs/heads/main\n');
    const paths = (await protectedPaths(root, home)).map((entry) => entry.path);
    for (const name of ['objects', 'refs', 'config', 'hooks']) {
      expect(paths).toContain(join(root, name));
    }
  });

  it('protects what a symlink at a protected path points to', async () => {
    const target = join(root, '..', 'dotfiles-zshrc');
    await writeFile(target, '');
    await symlink(target, join(root, '.zshrc'));
    const paths = (await protectedPaths(root, home)).map((entry) => entry.path);
    expect(paths).toContain(join(root, '.zshrc'));
    expect(paths).toContain(target);
  });

  it('follows a linked worktree to its git directory and the main repository', async () => {
    const main = join(root, '..', 'main');
    const gitDir = join(main, '.git', 'worktrees', 'wt');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'commondir'), '../..\n');
    const worktree = join(root, '..', 'wt');
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
    const paths = (await protectedPaths(worktree, home)).map((entry) => entry.path);
    expect(paths).toContain(join(worktree, '.git'));
    expect(paths).toContain(join(gitDir, 'hooks'));
    expect(paths).toContain(join(main, '.git', 'hooks'));
    expect(paths).toContain(join(main, '.git', 'config'));
  });

  it('does not protect a home config directory the root lies in', async () => {
    const inside = join(home, '.cogitator', 'workspaces', 'w');
    await mkdir(inside, { recursive: true });
    const paths = (await protectedPaths(inside, home)).map((entry) => entry.path);
    expect(paths).not.toContain(join(home, '.cogitator'));
    expect(paths).toContain(join(home, '.claude'));
  });
});
