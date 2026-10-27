import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@cogitator-ai/types';
import {
  experimental_keychainSecretStore,
  experimental_memorySecretStore,
  type SecretCommandRunner,
} from '../plugins/secrets';
import { loadPluginSettings, writeEnabledPlugin, writePluginOptions } from '../plugins/settings';

/**
 * The flags of a line `security -i` reads (`-s "service" -a "account" ...`), each quoted value
 * with its `\\` escapes undone, read in one pass
 */
function interactiveFlags(line: string): Map<string, string> {
  const flags = new Map<string, string>();
  let at = 0;
  let flag: string | undefined;
  while (at < line.length) {
    const char = line[at] ?? '';
    if (char === '"') {
      let value = '';
      at++;
      while (at < line.length && line[at] !== '"') {
        if (line[at] === '\\') at++;
        value += line[at] ?? '';
        at++;
      }
      at++;
      if (flag !== undefined) flags.set(flag, value);
      flag = undefined;
      continue;
    }
    if (char === '-') {
      const end = line.indexOf(' ', at);
      flag = line.slice(at, end === -1 ? line.length : end);
      at = end === -1 ? line.length : end;
      continue;
    }
    at++;
  }
  return flags;
}

/** A credential tool kept in memory, answering as `security` and `secret-tool` do */
function fakeTool(): {
  run: SecretCommandRunner;
  calls: { file: string; args: readonly string[]; input: string }[];
} {
  const items = new Map<string, string>();
  const calls: { file: string; args: readonly string[]; input: string }[] = [];
  const run: SecretCommandRunner = async (file, args, input) => {
    calls.push({ file, args, input });
    if (file === 'security') {
      if (args[0] === '-i') {
        const flags = interactiveFlags(input);
        const [service, account, secret] = [flags.get('-s'), flags.get('-a'), flags.get('-w')];
        if (service === undefined || account === undefined || secret === undefined) {
          return { code: 1, stdout: '', stderr: 'bad line' };
        }
        items.set(`${service}\n${account}`, secret);
        return { code: 0, stdout: '', stderr: '' };
      }
      const key = `${args[2]}\n${args[4]}`;
      if (args[0] === 'find-generic-password') {
        return items.has(key)
          ? { code: 0, stdout: `${items.get(key)}\n`, stderr: '' }
          : { code: 44, stdout: '', stderr: 'not found' };
      }
      if (args[0] === 'delete-generic-password') {
        return items.delete(key)
          ? { code: 0, stdout: '', stderr: '' }
          : { code: 44, stdout: '', stderr: '' };
      }
    }
    if (file === 'secret-tool') {
      const key = `${args.at(-3)}\n${args.at(-1)}`;
      if (args[0] === 'store') {
        items.set(key, input);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'lookup')
        return items.has(key)
          ? { code: 0, stdout: items.get(key) ?? '', stderr: '' }
          : { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'clear') {
        items.delete(key);
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    return { code: 2, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

describe('plugin secrets', () => {
  it('keeps a secret in the macOS keychain, never on a command line', async () => {
    const tool = fakeTool();
    const store = experimental_keychainSecretStore({ platform: 'darwin', run: tool.run });
    const secret = 'p@ss "quoted" \\ line\nbreak';
    await store.set('cogitator-plugin:x@m', 'token', secret);
    expect(await store.get('cogitator-plugin:x@m', 'token')).toBe(secret);
    expect(tool.calls.every((entry) => !entry.args.some((arg) => arg.includes('p@ss')))).toBe(true);
    expect(tool.calls[0]?.input).not.toContain('p@ss');
    await store.delete('cogitator-plugin:x@m', 'token');
    expect(await store.get('cogitator-plugin:x@m', 'token')).toBeUndefined();
    await store.delete('cogitator-plugin:x@m', 'token');
  });

  it('keeps a secret with secret-tool on Linux, the secret on standard input', async () => {
    const tool = fakeTool();
    const store = experimental_keychainSecretStore({ platform: 'linux', run: tool.run });
    await store.set('svc', 'acct', 'linux-secret');
    expect(tool.calls[0]?.args).not.toContain('linux-secret');
    expect(await store.get('svc', 'acct')).toBe('linux-secret');
    expect(await store.get('svc', 'other')).toBeUndefined();
  });

  it('fails with SECRET_STORE_UNAVAILABLE without a credential tool, instead of writing a file', async () => {
    const missing: SecretCommandRunner = async () => {
      const error = new Error('spawn secret-tool ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    };
    const store = experimental_keychainSecretStore({ platform: 'linux', run: missing });
    await expect(store.set('svc', 'acct', 'x')).rejects.toMatchObject({
      code: ErrorCode.SECRET_STORE_UNAVAILABLE,
    });
    await expect(
      experimental_keychainSecretStore({ platform: 'aix' }).get('a', 'b')
    ).rejects.toMatchObject({
      code: ErrorCode.SECRET_STORE_UNAVAILABLE,
      message: expect.stringMatching(/never written to a plain file/),
    });
  });

  it('runs PowerShell with the Credential Manager API on Windows, the request on standard input', async () => {
    const calls: { file: string; args: readonly string[]; input: string }[] = [];
    const store = experimental_keychainSecretStore({
      platform: 'win32',
      run: async (file, args, input) => {
        calls.push({ file, args, input });
        return { code: 3, stdout: '', stderr: '' };
      },
    });
    expect(await store.get('svc', 'acct')).toBeUndefined();
    expect(calls[0]?.file).toBe('powershell.exe');
    expect(calls[0]?.args.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    expect(JSON.parse(calls[0]?.input ?? '{}')).toEqual({ op: 'get', target: 'svc:acct' });
  });

  it('keeps secrets in memory when asked to', async () => {
    const store = experimental_memorySecretStore({ svc: { a: '1' } });
    expect(await store.get('svc', 'a')).toBe('1');
    await store.set('svc', 'b', '2');
    expect(await store.get('svc', 'b')).toBe('2');
  });
});

describe('plugin settings', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cog-plugin-settings-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const file = (path: string, json: unknown) => {
    mkdirSync(join(base, path, '..'), { recursive: true });
    writeFileSync(join(base, path), JSON.stringify(json));
  };

  it('takes enabledPlugins from the highest layer that names a plugin, managed over code over the files', async () => {
    file('managed/managed-settings.json', { enabledPlugins: { 'locked@m': false } });
    file('user/settings.json', {
      enabledPlugins: { 'a@m': true, 'b@m': true, 'locked@m': true },
      pluginConfigs: { 'a@m': { options: { level: 2 } } },
    });
    file('project/.claude/settings.json', { enabledPlugins: { 'b@m': false } });
    file('project/.cogitator/settings.local.json', { enabledPlugins: { 'c@m': true } });
    const settings = await loadPluginSettings(
      join(base, 'project'),
      {
        root: join(base, 'project'),
        userDirs: [join(base, 'user')],
        managedDirs: [join(base, 'managed')],
        trusted: true,
      },
      { enabled: { 'a@m': false, 'locked@m': true } }
    );
    expect(settings.enabled.get('locked@m')).toMatchObject({ value: false, layer: 'managed' });
    expect(settings.enabled.get('a@m')).toMatchObject({ value: false, layer: 'session' });
    expect(settings.enabled.get('b@m')).toMatchObject({ value: false, layer: 'project' });
    expect(settings.enabled.get('c@m')).toMatchObject({ value: true, layer: 'local' });
    expect(settings.options['a@m']).toEqual({ level: 2 });
  });

  it('ignores the plugin settings of an untrusted project, with a warning', async () => {
    file('project/.claude/settings.json', { enabledPlugins: { 'b@m': false } });
    const settings = await loadPluginSettings(join(base, 'project'), {
      root: join(base, 'project'),
      userDirs: [],
      managedDirs: [],
    });
    expect(settings.enabled.has('b@m')).toBe(false);
    expect(settings.warnings[0]).toMatch(/is not trusted, its plugin settings are ignored/);
  });

  it('writes enabledPlugins and pluginConfigs keeping what else a file holds', async () => {
    const path = join(base, 'user', 'settings.json');
    file('user/settings.json', { permissions: { allow: ['Read'] } });
    await writeEnabledPlugin(path, 'x@m', true);
    await writePluginOptions(path, 'x@m', { level: 3 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      permissions: { allow: ['Read'] },
      enabledPlugins: { 'x@m': true },
      pluginConfigs: { 'x@m': { options: { level: 3 } } },
    });
    await writeEnabledPlugin(path, 'x@m', undefined);
    await writePluginOptions(path, 'x@m', undefined);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissions: { allow: ['Read'] } });
  });
});
