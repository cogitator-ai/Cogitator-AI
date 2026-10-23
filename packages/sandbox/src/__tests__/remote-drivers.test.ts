import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkError } from '../workspace/remote/provider';
import * as scripts from '../workspace/remote/scripts';

/** How a fake sandbox answers the workspace: its scripts by name, its commands by marker lines. */
const fake = vi.hoisted(() => {
  const state = {
    root: '/home/user',
    calls: [] as { kind: string; args: unknown[] }[],
    files: new Map<string, Uint8Array>(),
    exitCode: 0,
    lateOutput: undefined as (() => void) | undefined,
  };
  return {
    state,
    reset(root: string) {
      state.root = root;
      state.calls = [];
      state.files = new Map();
      state.exitCode = 0;
      state.lateOutput = undefined;
    },
    record(kind: string, ...args: unknown[]) {
      state.calls.push({ kind, args });
    },
    callsOf(kind: string) {
      return state.calls.filter((call) => call.kind === kind);
    },
    /** The output of a command that runs `script` with the given words */
    marked(token: string, stdout: string, exitCode: number) {
      return {
        stdout,
        stderr: `__cogitator_${token}_pgid:42\n__cogitator_${token}_exit:${exitCode}\n`,
      };
    },
  };
});

/** The script an argv (or a shell line that quotes it) runs, by the constant it was built from. */
function scriptOf(command: string): keyof typeof scripts | undefined {
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    const quoted = `'${body.replaceAll("'", `'\\''`)}'`;
    if (command.includes(quoted) || command === body) return name as keyof typeof scripts;
  }
  return undefined;
}

function answer(script: keyof typeof scripts | undefined, words: string[]): string {
  if (script === 'START') return fake.state.root;
  if (script === 'READ') {
    const [target, , copy] = words.slice(-3);
    const bytes = fake.state.files.get(target);
    if (bytes) fake.state.files.set(copy, bytes);
    return '';
  }
  if (script === 'EXISTS') return '1';
  return '';
}

/** The words after the script in a shell line built by `shellCommand`. */
function words(command: string): string[] {
  const found = command.match(/'(?:[^']|'\\'')*'/g) ?? [];
  return found.map((word) => word.slice(1, -1).replaceAll(`'\\''`, "'"));
}

vi.mock('e2b', () => {
  class FileNotFoundError extends Error {}
  class CommandExitError extends Error {
    constructor(readonly result: { exitCode: number; stdout: string; stderr: string }) {
      super('exit');
    }
    get exitCode() {
      return this.result.exitCode;
    }
    get stdout() {
      return this.result.stdout;
    }
    get stderr() {
      return this.result.stderr;
    }
  }
  const sandbox = (sandboxId: string) => ({
    sandboxId,
    files: {
      read: (path: string, opts: unknown) => {
        fake.record('files.read', path, opts);
        const bytes = fake.state.files.get(path);
        if (!bytes) return Promise.reject(new FileNotFoundError(`file ${path} not found`));
        return Promise.resolve(bytes);
      },
      write: (path: string, data: ArrayBuffer) => {
        fake.record('files.write', path, data);
        fake.state.files.set(path, new Uint8Array(data));
        return Promise.resolve({ path });
      },
    },
    commands: {
      run: (
        cmd: string,
        opts: {
          background?: boolean;
          onStdout?: (data: string) => void;
          onStderr?: (data: string) => void;
        }
      ) => {
        fake.record('commands.run', cmd, opts);
        if (!opts.background) {
          const script = scriptOf(cmd);
          if (script === 'COMMIT_WRITE') {
            return Promise.reject(new CommandExitError({ exitCode: 50, stdout: '', stderr: '' }));
          }
          return Promise.resolve({ exitCode: 0, stdout: answer(script, words(cmd)), stderr: '' });
        }
        let token = '';
        return Promise.resolve({
          sendStdin: (data: string) => {
            token = data.trim();
            fake.record('sendStdin', data);
            return Promise.resolve();
          },
          closeStdin: () => {
            fake.record('closeStdin');
            return Promise.resolve();
          },
          wait: () => {
            const out = fake.marked(token, 'hi\n', fake.state.exitCode);
            opts.onStdout?.(out.stdout);
            opts.onStderr?.(out.stderr);
            return fake.state.exitCode === 0
              ? Promise.resolve({ exitCode: 0, ...out })
              : Promise.reject(new CommandExitError({ exitCode: fake.state.exitCode, ...out }));
          },
          kill: () => Promise.resolve(true),
          disconnect: () => Promise.resolve(),
        });
      },
    },
    kill: () => {
      fake.record('sandbox.kill', sandboxId);
      return Promise.resolve(true);
    },
    setTimeout: (ms: number) => {
      fake.record('sandbox.setTimeout', ms);
      return Promise.resolve();
    },
  });
  return {
    CommandExitError,
    FileNotFoundError,
    Sandbox: {
      create: (template: string, opts: unknown) => {
        fake.record('Sandbox.create', template, opts);
        return Promise.resolve(sandbox('sbx-new'));
      },
      connect: (id: string, opts: unknown) => {
        fake.record('Sandbox.connect', id, opts);
        return Promise.resolve(sandbox(id));
      },
    },
  };
});

vi.mock('@daytona/sdk', () => {
  class DaytonaNotFoundError extends Error {}
  const sessions = new Map<string, { token: string }>();
  const sandbox = (id: string, state: string) => ({
    id,
    state,
    fs: {
      uploadFile: (file: unknown, path: string) => {
        fake.record('fs.uploadFile', file, path);
        if (Buffer.isBuffer(file)) fake.state.files.set(path, new Uint8Array(file));
        return Promise.resolve();
      },
      downloadFile: (path: string) => {
        fake.record('fs.downloadFile', path);
        const bytes = fake.state.files.get(path);
        return bytes
          ? Promise.resolve(Buffer.from(bytes))
          : Promise.reject(new DaytonaNotFoundError('missing'));
      },
    },
    process: {
      createSession: (session: string) => {
        fake.record('createSession', session);
        sessions.set(session, { token: '' });
        return Promise.resolve();
      },
      executeSessionCommand: (
        session: string,
        req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean }
      ) => {
        fake.record('executeSessionCommand', session, req);
        if (req.runAsync) return Promise.resolve({ cmdId: 'cmd-1' });
        const script = scriptOf(req.command);
        return Promise.resolve({
          cmdId: 'cmd-sync',
          exitCode: 0,
          stdout: answer(script, words(req.command)),
          stderr: '',
        });
      },
      sendSessionCommandInput: (session: string, _cmd: string, data: string) => {
        fake.record('sendSessionCommandInput', session, data);
        sessions.get(session)!.token = data.trim();
        return Promise.resolve();
      },
      getSessionCommandLogs: (
        session: string,
        _cmd: string,
        onStdout: (chunk: string) => void,
        onStderr: (chunk: string) => void
      ) => {
        const out = fake.marked(sessions.get(session)!.token, 'hi\n', 3);
        onStdout(out.stdout);
        onStderr(out.stderr);
        fake.state.lateOutput = () => onStdout('late output\n');
        return Promise.resolve();
      },
      getSessionCommand: () => Promise.resolve({ exitCode: 3 }),
      deleteSession: (session: string) => {
        fake.record('deleteSession', session);
        return Promise.resolve();
      },
    },
    getWorkDir: () => Promise.resolve('/home/daytona'),
    start: () => {
      fake.record('sandbox.start', id);
      return Promise.resolve();
    },
    stop: () => {
      fake.record('sandbox.stop', id);
      return Promise.resolve();
    },
    delete: () => {
      fake.record('sandbox.delete', id);
      return Promise.resolve();
    },
  });
  class Daytona {
    constructor(config: unknown) {
      fake.record('new Daytona', config);
    }
    create(params: unknown, options: unknown) {
      fake.record('daytona.create', params, options);
      return Promise.resolve(sandbox('dt-new', 'started'));
    }
    get(idOrName: string) {
      fake.record('daytona.get', idOrName);
      return Promise.resolve(sandbox(idOrName, 'stopped'));
    }
  }
  return { Daytona, DaytonaNotFoundError };
});

vi.mock('@vercel/sandbox', () => {
  const sandbox = (name: string) => ({
    name,
    extendTimeout: (duration: number) => {
      fake.record('extendTimeout', duration);
      return Promise.resolve();
    },
    readFileToBuffer: ({ path }: { path: string }) => {
      fake.record('readFileToBuffer', path);
      const bytes = fake.state.files.get(path);
      return Promise.resolve(bytes ? Buffer.from(bytes) : null);
    },
    writeFiles: (files: { path: string; content: Uint8Array }[]) => {
      fake.record('writeFiles', files);
      for (const file of files) fake.state.files.set(file.path, file.content);
      return Promise.resolve();
    },
    runCommand: (params: { cmd: string; args: string[]; detached?: boolean }) => {
      fake.record('runCommand', params);
      if (!params.detached) {
        const script = scriptOf(params.args[1] ?? '');
        const missing = script === 'READ' && !fake.state.files.has(params.args.at(-3) ?? '');
        const stdout = answer(script, params.args);
        return Promise.resolve({
          exitCode: missing ? scripts.SCRIPT_EXIT.notFound : 0,
          stdout: () => Promise.resolve(stdout),
          stderr: () => Promise.resolve(''),
        });
      }
      let token = '';
      return Promise.resolve({
        writeStdin: (data: string) => {
          token = data.trim();
          fake.record('writeStdin', data);
          return Promise.resolve();
        },
        closeStdin: () => Promise.resolve(),
        logs: () => {
          const lines = async function* () {
            await Promise.resolve();
            const out = fake.marked(token, 'hi\n', 0);
            yield { stream: 'stdout' as const, data: out.stdout };
            yield { stream: 'stderr' as const, data: out.stderr };
          };
          return Object.assign(lines(), { close: () => undefined });
        },
        wait: () => Promise.resolve({ exitCode: 0 }),
        kill: () => Promise.resolve(),
      });
    },
    stop: () => {
      fake.record('sandbox.stop', name);
      return Promise.resolve({});
    },
    delete: (opts: unknown) => {
      fake.record('sandbox.delete', name, opts);
      return Promise.resolve();
    },
  });
  return {
    Sandbox: {
      create: (params: unknown) => {
        fake.record('Sandbox.create', params);
        return Promise.resolve(sandbox('vercel-new'));
      },
      getOrCreate: (params: { name: string }) => {
        fake.record('Sandbox.getOrCreate', params);
        return Promise.resolve(sandbox(params.name));
      },
    },
  };
});

const { E2BWorkspace } = await import('../workspace/remote/e2b-workspace');
const { DaytonaWorkspace } = await import('../workspace/remote/daytona-workspace');
const { VercelSandboxWorkspace } = await import('../workspace/remote/vercel-workspace');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('E2BWorkspace', () => {
  beforeEach(() => {
    fake.reset('/home/user');
    vi.stubEnv('E2B_API_KEY', '');
  });

  it('needs an API key and does not create a sandbox without one', async () => {
    const workspace = new E2BWorkspace();
    await expect(workspace.start()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('E2B_API_KEY'),
    });
    expect(fake.callsOf('Sandbox.create')).toHaveLength(0);
  });

  it('creates a sandbox from the template, runs commands and kills it on dispose', async () => {
    vi.stubEnv('E2B_API_KEY', 'e2b_test');
    const workspace = new E2BWorkspace({ template: 'node', metadata: { app: 'test' } });
    const result = await workspace.exec('echo hi');
    expect(result).toMatchObject({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    expect(workspace.sandboxId).toBe('sbx-new');
    const [create] = fake.callsOf('Sandbox.create');
    expect(create.args).toEqual([
      'node',
      { apiKey: 'e2b_test', timeoutMs: 30 * 60_000, metadata: { app: 'test' } },
    ]);
    const spawned = fake.callsOf('commands.run').find((call) => {
      const opts = call.args[1] as { background?: boolean };
      return opts.background === true;
    });
    expect(spawned?.args[1]).toMatchObject({ stdin: true, cwd: '/home/user' });
    expect(fake.callsOf('sendStdin')[0].args[0]).toMatch(/^[a-f0-9]{32}\n$/);
    expect(fake.callsOf('closeStdin')).toHaveLength(1);

    fake.state.exitCode = 5;
    expect((await workspace.exec('false')).exitCode).toBe(5);
    await workspace.dispose();
    expect(fake.callsOf('sandbox.kill')).toHaveLength(1);
  });

  it('reads through the file API and maps a non-zero script exit from CommandExitError', async () => {
    const workspace = new E2BWorkspace({ apiKey: 'explicit' });
    fake.state.files.set('/home/user/a.txt', new TextEncoder().encode('content'));
    expect(await workspace.read('a.txt')).toBe('content');
    const [read] = fake.callsOf('files.read');
    expect(read.args[0]).toMatch(/^\/home\/user\/\.cogitator\/pending\/read-[a-f0-9]{32}$/);
    expect(read.args[1]).toEqual({ format: 'bytes' });
    await expect(workspace.write('b.txt', 'x')).rejects.toMatchObject({ code: 'DENIED' });
    const upload = fake.callsOf('files.write')[0];
    expect(upload.args[0]).toMatch(/^\/home\/user\/\.cogitator\/pending\/upload-/);
    expect(upload.args[1]).toBeInstanceOf(ArrayBuffer);
    await workspace.dispose();
  });

  it('connects to a given sandbox and keeps it on dispose', async () => {
    const workspace = new E2BWorkspace({ apiKey: 'k', sandboxId: 'sbx-old', root: 'repo' });
    fake.state.root = '/home/user/repo';
    await workspace.start();
    expect(fake.callsOf('Sandbox.connect')[0].args).toEqual([
      'sbx-old',
      { apiKey: 'k', timeoutMs: 30 * 60_000 },
    ]);
    expect(workspace.root).toBe('/home/user/repo');
    await workspace.dispose();
    expect(fake.callsOf('sandbox.kill')).toHaveLength(0);
  });

  it('keeps the sandbox alive once half its lifetime has passed since the last extension', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const workspace = new E2BWorkspace({ apiKey: 'k', lifetime: 60_000 });
      await workspace.start();
      await workspace.exists('a');
      expect(fake.callsOf('sandbox.setTimeout')).toHaveLength(0);
      vi.setSystemTime(Date.now() + 31_000);
      await workspace.exists('a');
      await workspace.exists('a');
      expect(fake.callsOf('sandbox.setTimeout').map((call) => call.args[0])).toEqual([60_000]);
      await workspace.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DaytonaWorkspace', () => {
  beforeEach(() => {
    fake.reset('/home/daytona');
    vi.stubEnv('DAYTONA_API_KEY', '');
    vi.stubEnv('DAYTONA_API_URL', '');
    vi.stubEnv('DAYTONA_TARGET', '');
  });

  it('needs an API key', async () => {
    await expect(new DaytonaWorkspace().start()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('DAYTONA_API_KEY'),
    });
  });

  it('creates a sandbox, runs commands in sessions and deletes it on dispose', async () => {
    vi.stubEnv('DAYTONA_API_KEY', 'dtn_test');
    vi.stubEnv('DAYTONA_TARGET', 'eu');
    const workspace = new DaytonaWorkspace({ image: 'node:24', resources: { cpu: 2 } });
    const result = await workspace.exec('echo hi', { env: { A: "it's" } });
    expect(result).toMatchObject({ stdout: 'hi\n', exitCode: 3 });
    expect(fake.callsOf('new Daytona')[0].args[0]).toEqual({ apiKey: 'dtn_test', target: 'eu' });
    expect(fake.callsOf('daytona.create')[0].args[0]).toEqual({
      image: 'node:24',
      resources: { cpu: 2 },
    });
    const commands = fake
      .callsOf('executeSessionCommand')
      .map(
        (call) =>
          call.args[1] as { command: string; runAsync?: boolean; suppressInputEcho?: boolean }
      );
    const started = commands.find((command) => command.runAsync);
    expect(started).toMatchObject({ suppressInputEcho: true });
    expect(started?.command).toMatch(
      /^cd '\/home\/daytona' && \( \. '\/tmp\/cogitator-env-[^']+' && exec 'setsid' '-w'/
    );
    expect(started?.command).not.toContain("it'\\''s");
    const envFile = fake
      .callsOf('fs.uploadFile')
      .find((call) => String(call.args[1]).startsWith('/tmp/cogitator-env-'));
    expect(String(envFile?.args[0])).toBe(
      `export A='it'\\''s'\nrm -f -- '${String(envFile?.args[1])}'\n`
    );
    const script = commands.find((command) => !command.runAsync);
    expect(script?.command).toMatch(/<\/dev\/null$/);
    expect(fake.callsOf('sendSessionCommandInput')[0].args[1]).toMatch(/^[a-f0-9]{32}\n$/);
    const asyncSession = fake.callsOf('sendSessionCommandInput')[0].args[0];
    expect(fake.callsOf('deleteSession').map((call) => call.args[0])).toContain(asyncSession);
    await expect(workspace.exec('true', { env: { 'BAD NAME': 'x' } })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await workspace.dispose();
    expect(fake.callsOf('sandbox.delete')).toHaveLength(1);
  });

  it('refuses an image together with a snapshot', () => {
    expect(() => new DaytonaWorkspace({ image: 'node:24', snapshot: 'snap' })).toThrow(
      /an image or a snapshot/
    );
  });

  it('ignores the output of a kept command once it returned', async () => {
    const workspace = new DaytonaWorkspace({ apiKey: 'k' });
    const seen: string[] = [];
    await workspace.exec('server &', { background: 'keep', onStdout: (chunk) => seen.push(chunk) });
    fake.state.lateOutput?.();
    expect(seen.join('')).toBe('hi\n');
    await workspace.dispose();
  });

  it('uploads a Buffer, never a string a local path would be read from', async () => {
    const workspace = new DaytonaWorkspace({ apiKey: 'k' });
    await workspace.write('a.txt', 'text content').catch(() => undefined);
    const upload = fake.callsOf('fs.uploadFile')[0];
    expect(Buffer.isBuffer(upload.args[0])).toBe(true);
    expect(String(upload.args[0])).toBe('text content');
    await workspace.dispose();
  });

  it('starts a stopped sandbox it reuses and keeps it, or stops it when asked', async () => {
    const kept = new DaytonaWorkspace({ apiKey: 'k', sandbox: 'my-box' });
    await kept.start();
    expect(fake.callsOf('daytona.get')[0].args[0]).toBe('my-box');
    expect(fake.callsOf('sandbox.start')).toHaveLength(1);
    await kept.dispose();
    expect(fake.callsOf('sandbox.delete')).toHaveLength(0);
    const stopped = new DaytonaWorkspace({ apiKey: 'k', sandbox: 'my-box', onDispose: 'stop' });
    await stopped.start();
    await stopped.dispose();
    expect(fake.callsOf('sandbox.stop')).toHaveLength(1);
  });
});

describe('VercelSandboxWorkspace', () => {
  beforeEach(() => {
    fake.reset('/vercel/sandbox');
    for (const name of [
      'VERCEL_OIDC_TOKEN',
      'VERCEL_TOKEN',
      'VERCEL_TEAM_ID',
      'VERCEL_PROJECT_ID',
    ]) {
      vi.stubEnv(name, '');
    }
  });

  it('refuses a partial token triple and leaves OIDC to the SDK', async () => {
    const oidc = new VercelSandboxWorkspace();
    await oidc.start();
    expect(fake.callsOf('Sandbox.create')[0].args[0]).not.toHaveProperty('token');
    await oidc.dispose();
    fake.reset('/vercel/sandbox');
    await expect(new VercelSandboxWorkspace({ token: 't' }).start()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('teamId (VERCEL_TEAM_ID), projectId (VERCEL_PROJECT_ID)'),
    });
    expect(fake.callsOf('Sandbox.create')).toHaveLength(0);
  });

  it('creates a sandbox with OIDC, runs argv without a shell line and deletes it', async () => {
    vi.stubEnv('VERCEL_OIDC_TOKEN', 'oidc');
    const workspace = new VercelSandboxWorkspace({ image: 'vercel/sandbox/node:24' });
    const result = await workspace.exec('echo hi');
    expect(result).toMatchObject({ stdout: 'hi\n', exitCode: 0 });
    expect(fake.callsOf('Sandbox.create')[0].args[0]).toEqual({
      image: 'vercel/sandbox/node:24',
      timeout: 30 * 60_000,
      persistent: false,
    });
    const detached = fake
      .callsOf('runCommand')
      .map((call) => call.args[0] as { cmd: string; args: string[]; detached?: boolean })
      .find((params) => params.detached);
    expect(detached).toMatchObject({ cmd: 'setsid', stdin: true, cwd: '/vercel/sandbox' });
    expect(detached?.args.at(-1)).toBe('echo hi');
    await expect(workspace.read('missing.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await workspace.dispose();
    expect(fake.callsOf('sandbox.delete')[0].args[1]).toEqual({ deleteOrphanSnapshots: true });
    expect(() => new VercelSandboxWorkspace({ image: 'a', runtime: 'node24' })).toThrow(
      /an image or a runtime/
    );
  });

  it('reuses a sandbox by name with the token triple and stops it on dispose', async () => {
    vi.stubEnv('VERCEL_TOKEN', 'tok');
    vi.stubEnv('VERCEL_TEAM_ID', 'team');
    vi.stubEnv('VERCEL_PROJECT_ID', 'proj');
    const workspace = new VercelSandboxWorkspace({ name: 'agent-box' });
    await workspace.start();
    expect(workspace.sandboxId).toBe('agent-box');
    expect(fake.callsOf('Sandbox.getOrCreate')[0].args[0]).toEqual({
      token: 'tok',
      teamId: 'team',
      projectId: 'proj',
      name: 'agent-box',
      timeout: 30 * 60_000,
      resume: true,
    });
    await workspace.dispose();
    expect(fake.callsOf('sandbox.stop')).toHaveLength(1);
    expect(fake.callsOf('sandbox.delete')).toHaveLength(0);
  });
});

describe('remote workspaces without their SDK', () => {
  it.each([
    ['e2b', '../workspace/remote/e2b-workspace', 'E2BWorkspace'],
    ['@daytona/sdk', '../workspace/remote/daytona-workspace', 'DaytonaWorkspace'],
    ['@vercel/sandbox', '../workspace/remote/vercel-workspace', 'VercelSandboxWorkspace'],
  ])('says %s is missing', async (pkg, path, name) => {
    vi.resetModules();
    vi.doMock(pkg, () => {
      throw Object.assign(new Error(`Cannot find package '${pkg}' imported from here`), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    });
    try {
      const module = (await import(path)) as Record<
        string,
        new (options: { apiKey: string }) => { start(): Promise<void> }
      >;
      const workspace = new module[name]({ apiKey: 'k' });
      await expect(workspace.start()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringContaining(`the ${pkg} package`),
      });
    } finally {
      vi.doUnmock(pkg);
    }
  });

  it('says "install it" only when the package itself is missing', () => {
    const missing = Object.assign(new Error("Cannot find package 'e2b' imported from x.js"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(sdkError('E2BWorkspace', 'e2b', missing).message).toBe(
      'E2BWorkspace needs the e2b package: install it next to @cogitator-ai/sandbox'
    );
    const dependency = Object.assign(new Error("Cannot find package 'undici' imported from e2b"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(sdkError('E2BWorkspace', 'e2b', dependency).message).toContain(
      'could not load the e2b package'
    );
    expect(sdkError('E2BWorkspace', 'e2b', new SyntaxError('Unexpected token')).message).toBe(
      'E2BWorkspace could not load the e2b package: Unexpected token'
    );
  });
});
