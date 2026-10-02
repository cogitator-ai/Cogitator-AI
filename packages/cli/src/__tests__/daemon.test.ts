import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BUNDLE_MARKER,
  buildLaunchdPlist,
  buildSystemdUnit,
  escapeXml,
  isCogitatorBundle,
  isDaemonProcess,
  isProcessAlive,
  parsePidRecord,
  quoteSystemdArg,
  resolveDaemonLaunch,
  serializePidRecord,
} from '../utils/daemon.js';

const NODE = '/usr/bin/node';
const CLI = '/opt/cogitator/dist/index.js';

describe('resolveDaemonLaunch', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cli-daemon-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const launch = (config?: string) =>
    resolveDaemonLaunch({ cwd, nodePath: NODE, cliEntry: CLI, config });

  it('runs a cogitator bundle directly with node', () => {
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(
      join(cwd, 'dist/cogitator.mjs'),
      `#!/usr/bin/env node\nimport { createRequire as ${BUNDLE_MARKER} } from "module";`
    );
    writeFileSync(join(cwd, 'cogitator.yml'), 'name: x');
    expect(launch()).toMatchObject({ command: NODE, args: [join(cwd, 'dist/cogitator.mjs')] });
  });

  it('starts legacy bundles (no marker) through the assistant command', () => {
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist/cogitator.mjs'), 'export const gateway = {};');
    expect(launch().args).toEqual([
      CLI,
      'assistant',
      '--quiet',
      '--config',
      join(cwd, 'dist/cogitator.mjs'),
    ]);
  });

  it('runs cogitator.yml through "cogitator up"', () => {
    writeFileSync(join(cwd, 'cogitator.yml'), 'name: x');
    expect(launch().args).toEqual([CLI, 'up', '--config', join(cwd, 'cogitator.yml')]);
  });

  it('runs src/gateway.ts through "cogitator assistant" instead of plain node', () => {
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src/gateway.ts'), 'export const gateway = {};');
    expect(launch().args).toEqual([
      CLI,
      'assistant',
      '--quiet',
      '--config',
      join(cwd, 'src/gateway.ts'),
    ]);
  });

  it('honours an explicit config path', () => {
    writeFileSync(join(cwd, 'custom.yaml'), 'name: x');
    expect(launch('custom.yaml').args).toEqual([CLI, 'up', '--config', join(cwd, 'custom.yaml')]);
  });

  it('throws when nothing can be run', () => {
    expect(() => launch()).toThrow('Nothing to run');
    expect(() => launch('missing.ts')).toThrow('Config not found');
  });
});

describe('isCogitatorBundle', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-bundle-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects the build banner and ignores other files', () => {
    writeFileSync(join(dir, 'a.mjs'), `const require = ${BUNDLE_MARKER}(import.meta.url);`);
    writeFileSync(join(dir, 'b.mjs'), 'console.log(1)');
    writeFileSync(join(dir, 'c.ts'), BUNDLE_MARKER);
    expect(isCogitatorBundle(join(dir, 'a.mjs'))).toBe(true);
    expect(isCogitatorBundle(join(dir, 'b.mjs'))).toBe(false);
    expect(isCogitatorBundle(join(dir, 'c.ts'))).toBe(false);
  });
});

describe('pid records', () => {
  it('parses legacy plain pids and JSON records', () => {
    expect(parsePidRecord('1234\n')).toEqual({ pid: 1234 });
    expect(parsePidRecord(serializePidRecord({ pid: 42, script: '/a b/c.js' }))).toEqual({
      pid: 42,
      script: '/a b/c.js',
    });
  });

  it('rejects garbage', () => {
    expect(parsePidRecord('')).toBeNull();
    expect(parsePidRecord('abc')).toBeNull();
    expect(parsePidRecord('0')).toBeNull();
    expect(parsePidRecord('{"pid":-1}')).toBeNull();
    expect(parsePidRecord('{"pid":"1"}')).toBeNull();
  });

  it('detects the current process as alive and verifies its command line', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isDaemonProcess({ pid: process.pid })).toBe(true);
    if (process.platform !== 'win32') {
      expect(isDaemonProcess({ pid: process.pid, script: 'definitely-not-in-argv-xyz' })).toBe(
        false
      );
    }
  });

  it('treats a non-existent pid as not running', () => {
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('service definitions', () => {
  const definition = {
    launch: {
      command: NODE,
      args: [CLI, 'up', '--config', '/home/me/My Bot & Co/cogitator.yml'],
      description: '',
    },
    cwd: '/home/me/My Bot & Co',
    logFile: '/home/me/My Bot & Co/.cogitator/daemon.log',
    path: '/usr/local/bin:/usr/bin',
  };

  it('escapes XML special characters in the launchd plist', () => {
    const plist = buildLaunchdPlist(definition);
    expect(plist).toContain('<string>/home/me/My Bot &amp; Co</string>');
    expect(plist).toContain(`<string>${CLI}</string>`);
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).not.toContain('& Co');
    expect(escapeXml(`<a href="x">'`)).toBe('&lt;a href=&quot;x&quot;&gt;&apos;');
  });

  it('builds a user systemd unit with quoted arguments', () => {
    const unit = buildSystemdUnit(definition);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('multi-user.target');
    expect(unit).toContain(
      `ExecStart=${NODE} ${CLI} up --config "/home/me/My Bot & Co/cogitator.yml"`
    );
    expect(unit).toContain('WorkingDirectory="/home/me/My Bot & Co"');
    expect(unit).toContain('Environment=PATH=/usr/local/bin:/usr/bin');
  });

  it('escapes percent signs for systemd specifiers', () => {
    expect(quoteSystemdArg('100%')).toBe('"100%%"');
    expect(quoteSystemdArg('/plain/path')).toBe('/plain/path');
  });
});
