import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CogitatorError, ErrorCode, WorkspaceError } from '@cogitator-ai/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OsSandbox } from '../os/os-sandbox';
import { probeOsSandbox } from '../os/probe';
import { runSandboxed } from './helpers/os-sandbox-run';

const probe = await probeOsSandbox();
const hasCurl = (() => {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const quiet = { onWarning: () => undefined };

describe('OsSandbox without the sandbox on the machine', () => {
  it('refuses to start with SANDBOX_UNAVAILABLE and the reason', async () => {
    const sandbox = new OsSandbox({ platform: 'win32', ...quiet });
    const error = await sandbox.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CogitatorError);
    expect((error as CogitatorError).code).toBe(ErrorCode.SANDBOX_UNAVAILABLE);
    expect((error as CogitatorError).message).toContain('not on win32');
    await expect(
      sandbox.launch({
        file: '/bin/sh',
        args: ['-c', 'true'],
        cwd: '/',
        env: {},
        root: '/',
        command: 'true',
        request: {},
      })
    ).rejects.toMatchObject({ code: ErrorCode.SANDBOX_UNAVAILABLE });
  });

  it('runs commands outside it, saying so, when the policy allows that', async () => {
    const warnings: string[] = [];
    const sandbox = new OsSandbox({
      platform: 'win32',
      policy: { failIfUnavailable: false },
      onWarning: (message) => warnings.push(message),
    });
    await sandbox.start();
    expect(await sandbox.route('ls')).toEqual({ sandboxed: false, reason: 'unavailable' });
    const launch = await sandbox.launch({
      file: '/bin/sh',
      args: ['-c', 'ls'],
      cwd: '/',
      env: {},
      root: '/',
      command: 'ls',
      request: {},
    });
    expect(launch.file).toBe('/bin/sh');
    expect(await launch.cleanup?.(undefined)).toEqual({
      sandbox: {
        sandboxed: false,
        kind: 'bubblewrap',
        unsandboxedReason: 'unavailable',
        violations: [],
      },
    });
    expect(warnings.join('\n')).toContain('UNSANDBOXED');
  });

  it('refuses a disabled policy and warns about entries it cannot read', () => {
    expect(() => new OsSandbox({ policy: { enabled: false } })).toThrow(RangeError);
    const warnings: string[] = [];
    const sandbox = new OsSandbox({
      policy: { network: { allowedDomains: ['ok.com', 'not a host'] } },
      onWarning: (message) => warnings.push(message),
    });
    expect(sandbox.warnings).toEqual(warnings);
    expect(warnings[0]).toContain('not a host');
  });

  it('routes excluded commands and honored unsandboxed requests outside the sandbox', async () => {
    const sandbox = new OsSandbox({
      platform: 'win32',
      policy: { failIfUnavailable: false, excludedCommands: ['docker *'] },
      ...quiet,
    });
    expect(await sandbox.route('docker ps')).toEqual({ sandboxed: false, reason: 'unavailable' });
  });
});

describe.skipIf(!probe.available)(`OsSandbox on this machine (${probe.kind})`, () => {
  let base: string;
  let root: string;
  let outside: string;
  let server: Server;
  let serverPort: number;
  const sandboxes: OsSandbox[] = [];

  const make = (options: ConstructorParameters<typeof OsSandbox>[0] = {}) => {
    const sandbox = new OsSandbox({ ...quiet, ...options });
    sandboxes.push(sandbox);
    return sandbox;
  };

  beforeAll(async () => {
    server = createServer((_req, res) => res.end('hello from the test server'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    serverPort = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'os-sandbox-')));
    root = join(base, 'project');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
  });

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.dispose()));
    await rm(base, { recursive: true, force: true });
  });

  it('starts and routes plain commands into the sandbox', async () => {
    const sandbox = await OsSandbox.create(quiet);
    sandboxes.push(sandbox);
    expect(sandbox.kind).toBe(probe.kind);
    expect(await sandbox.route('ls -la')).toEqual({ sandboxed: true });
  });

  it('writes in the root and its own TMPDIR, never outside', async () => {
    const sandbox = make();
    const ok = await runSandboxed(
      sandbox,
      root,
      'echo inside > a.txt && echo tmp > "$TMPDIR/t" && cat "$TMPDIR/t" && echo "$COGITATOR_SANDBOX"'
    );
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe(`tmp\n${probe.kind}\n`);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('inside\n');
    expect(ok.sandbox).toEqual({ sandboxed: true, kind: probe.kind, violations: [] });

    const refused = await runSandboxed(sandbox, root, `echo x > ${join(outside, 'x.txt')}`);
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    expect(refused.sandbox?.violations[0]).toMatchObject({ kind: 'filesystem' });
    expect(refused.stderr).toContain('<sandbox_violations>');
  });

  it('writes where allowWrite opens and not where denyWrite closes', async () => {
    const sandbox = make({
      policy: { filesystem: { allowWrite: [outside], denyWrite: ['locked'] } },
    });
    await mkdir(join(root, 'locked'));
    const result = await runSandboxed(
      sandbox,
      root,
      `echo y > ${join(outside, 'y.txt')}; echo z > locked/z.txt`
    );
    expect(await readFile(join(outside, 'y.txt'), 'utf8')).toBe('y\n');
    expect(existsSync(join(root, 'locked', 'z.txt'))).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('hides denyRead, reopens a narrower allowRead, and holds a deny inside a wider allow', async () => {
    await mkdir(join(outside, 'open'), { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await writeFile(join(outside, 'open', 'note.txt'), 'note');
    await writeFile(join(outside, 'open', '.env'), 'TOKEN=1');
    const sandbox = make({
      policy: {
        filesystem: {
          denyRead: [outside, join(outside, 'open', '.env')],
          allowRead: [join(outside, 'open')],
        },
      },
    });
    const secret = await runSandboxed(sandbox, root, `cat ${join(outside, 'secret.txt')}`);
    expect(secret.exitCode).not.toBe(0);
    expect(secret.stdout).toBe('');
    const note = await runSandboxed(sandbox, root, `cat ${join(outside, 'open', 'note.txt')}`);
    expect(note.stdout).toBe('note');
    const env = await runSandboxed(sandbox, root, `cat ${join(outside, 'open', '.env')}`);
    expect(env.stdout).toBe('');
  });

  it('keeps the protected paths read-only inside the root, through symlinks too', async () => {
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), '[core]\n');
    await mkdir(join(root, 'dotfiles', 'claude'), { recursive: true });
    await writeFile(join(root, 'dotfiles', 'claude', 'settings.json'), '{}');
    await symlink(join(root, 'dotfiles', 'claude'), join(root, '.claude'));
    const sandbox = make();
    const result = await runSandboxed(
      sandbox,
      root,
      [
        'echo bad > .bashrc',
        'echo bad > .git/hooks/pre-commit',
        'echo bad >> .git/config',
        'echo bad > .mcp.json',
        'mkdir -p .cogitator && echo bad > .cogitator/settings.json',
        'echo bad > dotfiles/claude/settings.json',
        'echo bad > HEAD',
        'echo fine > ok.txt',
      ].join('; ')
    );
    expect(existsSync(join(root, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n');
    expect(existsSync(join(root, '.cogitator', 'settings.json'))).toBe(false);
    expect(await readFile(join(root, 'dotfiles', 'claude', 'settings.json'), 'utf8')).toBe('{}');
    for (const name of ['.bashrc', '.mcp.json', 'HEAD']) {
      expect(existsSync(join(root, name)), name).toBe(false);
    }
    expect(await readFile(join(root, 'ok.txt'), 'utf8')).toBe('fine\n');
    expect(result.sandbox?.violations.length).toBeGreaterThan(0);
  });

  it('removes the credential variables from the environment', async () => {
    const sandbox = make({ policy: { credentials: { envVars: ['SECRET_TOKEN'] } } });
    const result = await runSandboxed(
      sandbox,
      root,
      'echo "token=${SECRET_TOKEN:-none} other=$OTHER"',
      {},
      { SECRET_TOKEN: 'abc', OTHER: 'kept' }
    );
    expect(result.stdout).toBe('token=none other=kept\n');
  });

  it.skipIf(!hasCurl)('reaches an allowed local server only through the proxy', async () => {
    const sandbox = make({ policy: { network: { allowedDomains: [`127.0.0.1:${serverPort}`] } } });
    const proxied = await runSandboxed(
      sandbox,
      root,
      `curl -s -m 10 http://127.0.0.1:${serverPort}/`
    );
    expect(proxied.stdout).toBe('hello from the test server');
    const direct = await runSandboxed(
      sandbox,
      root,
      `curl -s -m 5 --noproxy '*' http://127.0.0.1:${serverPort}/`
    );
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stdout).toBe('');
  });

  it.skipIf(!hasCurl)('refuses a host no list allows and reports it as a violation', async () => {
    const sandbox = make({ policy: { network: { allowedDomains: [`127.0.0.1:${serverPort}`] } } });
    const result = await runSandboxed(sandbox, root, 'curl -s -m 10 https://example.com/');
    expect(result.exitCode).not.toBe(0);
    expect(result.sandbox?.violations).toContainEqual({
      kind: 'network',
      operation: 'network-outbound',
      target: 'example.com:443',
      reason: 'not on the allow list, and nothing decides other hosts',
    });
    expect(result.stderr).toContain(
      '<sandbox_violations>\ndeny network-outbound example.com:443 (not on the allow list, and nothing decides other hosts)\n</sandbox_violations>'
    );
  });

  it.skipIf(!hasCurl)('asks the call decider about other hosts, then the sandbox one', async () => {
    const own = vi.fn(async () => false);
    const sandbox = make({ onUnknownHost: own });
    const call = vi.fn(async () => true);
    const allowed = await runSandboxed(
      sandbox,
      root,
      `curl -s -m 10 http://127.0.0.1:${serverPort}/`,
      { onUnknownHost: call }
    );
    expect(allowed.stdout).toBe('hello from the test server');
    expect(call).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: serverPort,
      command: `curl -s -m 10 http://127.0.0.1:${serverPort}/`,
    });
    const refused = await runSandboxed(
      sandbox,
      root,
      `curl -s -m 10 http://127.0.0.1:${serverPort}/`
    );
    expect(refused.stdout).not.toContain('hello from the test server');
    expect(refused.sandbox?.violations[0]?.reason).toContain('the permission check refused it');
    expect(own).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!hasCurl)('opens the hosts a command lists for that command alone', async () => {
    const sandbox = make();
    const listed = await runSandboxed(
      sandbox,
      root,
      `curl -s -m 10 http://127.0.0.1:${serverPort}/`,
      { allowedDomains: [`127.0.0.1:${serverPort}`] }
    );
    expect(listed.stdout).toBe('hello from the test server');
    const next = await runSandboxed(sandbox, root, `curl -s -m 10 http://127.0.0.1:${serverPort}/`);
    expect(next.stdout).not.toContain('hello from the test server');
    const strict = make({ policy: { network: { strictAllowlist: true } } });
    await expect(
      runSandboxed(strict, root, 'true', { allowedDomains: ['example.com'] })
    ).rejects.toSatisfy((error: unknown) => WorkspaceError.is(error, 'DENIED'));
  });

  it('runs excluded commands and honored unsandboxed requests outside the sandbox', async () => {
    const target = join(outside, 'free.txt');
    const sandbox = make({ policy: { excludedCommands: ['touch *'] } });
    const excluded = await runSandboxed(sandbox, root, `touch ${target}`);
    expect(excluded.sandbox).toEqual({
      sandboxed: false,
      kind: probe.kind,
      unsandboxedReason: 'excluded',
      violations: [],
    });
    expect(existsSync(target)).toBe(true);

    const second = join(outside, 'second.txt');
    const ignored = await runSandboxed(sandbox, root, `echo x > ${second}`, {
      dangerouslyDisableSandbox: true,
    });
    expect(ignored.sandbox?.sandboxed).toBe(true);
    expect(existsSync(second)).toBe(false);

    const escape = make({ policy: { allowUnsandboxed: true } });
    const honored = await runSandboxed(escape, root, `echo x > ${second}`, {
      dangerouslyDisableSandbox: true,
    });
    expect(honored.sandbox?.unsandboxedReason).toBe('requested');
    expect(existsSync(second)).toBe(true);
  });

  it('writes everywhere without filesystem isolation, the network still confined', async () => {
    const sandbox = make({ policy: { filesystem: { disabled: true } } });
    const target = join(outside, 'open.txt');
    const result = await runSandboxed(
      sandbox,
      root,
      hasCurl ? `echo x > ${target} && curl -s -m 5 https://example.com/` : `echo x > ${target}`
    );
    expect(existsSync(target)).toBe(true);
    if (hasCurl) expect(result.sandbox?.violations[0]?.kind).toBe('network');
  });

  it('cleans up its proxies and directories on dispose', async () => {
    const sandbox = make();
    const launch = await sandbox.launch({
      file: '/bin/sh',
      args: ['-c', 'true'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      root,
      command: 'true',
      request: {},
    });
    const tmp = launch.env?.TMPDIR;
    expect(tmp && existsSync(tmp)).toBe(true);
    await sandbox.dispose();
    expect(tmp && existsSync(tmp)).toBe(false);
    await expect(
      sandbox.launch({
        file: '/bin/sh',
        args: [],
        cwd: root,
        env: {},
        root,
        command: 'true',
        request: {},
      })
    ).rejects.toSatisfy((error: unknown) => WorkspaceError.is(error, 'DISPOSED'));
  });
});
