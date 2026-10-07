import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { planProject, writeFiles } from 'create-cogitator-app';
import {
  CommandError,
  debugEnabled,
  EXIT,
  examplesHelp,
  exitCodeOf,
  reportFailure,
  UsageError,
} from '../utils/cli.js';
import { createProgram } from '../program.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '../index.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
  vi.restoreAllMocks();
});

function cogitator(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', TSX, ENTRY, ...args], {
      cwd: options.cwd ?? tmpdir(),
      env: { ...process.env, FORCE_COLOR: '0', ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('exit codes', () => {
  it('are 0 for done, 1 for failed and 2 for a wrong command line', () => {
    expect(exitCodeOf(new CommandError('deploy failed'))).toBe(EXIT.failed);
    expect(exitCodeOf(new UsageError('unknown target'))).toBe(EXIT.usage);
    expect(exitCodeOf(new CommanderError(1, 'commander.unknownOption', 'x'))).toBe(EXIT.usage);
    expect(exitCodeOf(new CommanderError(0, 'commander.helpDisplayed', ''))).toBe(EXIT.ok);
    expect(exitCodeOf(new Error('boom'))).toBe(EXIT.failed);
  });

  it('come out of the binary the same way for every command', async () => {
    const [unknownOption, unknownCommand, unknownAction] = await Promise.all([
      cogitator(['doctor', '--nope']),
      cogitator(['deplyo']),
      cogitator(['deploy', 'nope']),
    ]);
    expect(unknownOption.code).toBe(2);
    expect(unknownOption.stderr).toContain("unknown option '--nope'");
    expect(unknownCommand.code).toBe(2);
    expect(unknownCommand.stderr).toContain('Did you mean deploy?');
    expect(unknownAction.code).toBe(2);
    expect(unknownAction.stderr).toContain('Available actions: status, destroy');
  }, 60_000);
});

describe('failures', () => {
  it('print JSON on stdout with --json', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)));
    const code = reportFailure(
      new UsageError('Unsupported deploy target: "x"', ['Available targets: docker, fly']),
      {
        json: true,
      }
    );
    expect(code).toBe(2);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      ok: false,
      error: {
        message: 'Unsupported deploy target: "x"',
        exitCode: 2,
        hints: ['Available targets: docker, fly'],
      },
    });
  });

  it('print the message and hints on stderr, with the stack only under COGITATOR_DEBUG', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) =>
      lines.push(args.map(String).join(' '))
    );
    reportFailure(new Error('boom'), { json: false, env: {} });
    expect(lines.join('\n')).toContain('boom');
    expect(lines.join('\n')).toContain('COGITATOR_DEBUG=1');
    expect(lines.join('\n')).not.toContain('at ');

    lines.length = 0;
    reportFailure(new Error('boom'), { json: false, env: { COGITATOR_DEBUG: '1' } });
    expect(lines.join('\n')).toMatch(/Error: boom\n\s+at /);
    expect(debugEnabled({ COGITATOR_DEBUG: 'false' })).toBe(false);
  });
});

describe('help', () => {
  function helpOf(command: Command): string {
    let text = '';
    command.configureOutput({ writeOut: (chunk) => (text += chunk) });
    command.outputHelp();
    return text;
  }

  it('shows examples on every command', () => {
    const program = createProgram();
    for (const command of program.commands) {
      expect(helpOf(command), command.name()).toContain('Examples:');
    }
  });

  it('formats examples as commands with what they do', () => {
    expect(examplesHelp([['cogitator status', 'the services']])).toContain('$ cogitator status  ');
  });
});

describe('--json', () => {
  it('lists Ollama models', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          models: [
            { name: 'small:1b', size: 1_000, modified_at: '2026-10-01T00:00:00Z' },
            { name: 'big:9b', size: 9_000, modified_at: '2026-09-01T00:00:00Z' },
          ],
        })
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const result = await cogitator(['models', '--url', url, '--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      url,
      models: [
        { name: 'big:9b', size: 9_000, modifiedAt: '2026-09-01T00:00:00Z' },
        { name: 'small:1b', size: 1_000, modifiedAt: '2026-10-01T00:00:00Z' },
      ],
    });
  }, 30_000);

  it('prints the deploy plan with secrets, services and preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-deploy-json-'));
    dirs.push(dir);
    const plan = planProject({
      name: 'deploy-json',
      app: 'server',
      server: 'hono',
      memory: 'postgres',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      packageManager: 'pnpm',
      deploy: 'docker',
    });
    await writeFiles(dir, plan.files);
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');

    const result = await cogitator(['deploy', '--dry-run', '--json'], {
      cwd: dir,
      env: { OPENAI_API_KEY: '', DATABASE_URL: '', API_TOKEN: '' },
    });

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      secrets: string[];
      services: { postgres: boolean };
      preflight: {
        passed: boolean;
        checks: Array<{ name: string; passed: boolean; fix?: string }>;
      };
    };
    expect(report.dryRun).toBe(true);
    expect(report.secrets).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'DATABASE_URL', 'API_TOKEN'])
    );
    expect(report.services.postgres).toBe(true);
    const secret = report.preflight.checks.find((check) => check.name === 'Secret: OPENAI_API_KEY');
    expect(secret).toMatchObject({ passed: false, fix: expect.stringContaining('OPENAI_API_KEY') });
    expect(report.ok).toBe(false);
    expect(result.code).toBe(1);
  }, 60_000);
});
