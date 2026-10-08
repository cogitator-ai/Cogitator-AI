import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isbot, isbotMatches } from 'isbot';
import { c as createTar } from 'tar';
import { run } from '../cli/main.js';
import {
  firstRunNotice,
  PAYLOAD_FIELDS,
  payloadFor,
  sendTelemetry,
  telemetryDisabledReason,
  telemetryErrorCode,
  telemetryUserAgent,
  type TelemetryPayload,
} from '../kit/telemetry.js';
import { IncompatibleSpecError } from '../kit/compat.js';
import { CodedError } from '../kit/errors.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cca-telemetry-'));
  roots.push(dir);
  return dir;
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { type: string; payload: { website: string; name: string; data: Record<string, string> } };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/install-errors');

/** A GitHub archive of a template that depends on one package. */
async function templateArchive(): Promise<Buffer> {
  const staging = temp();
  const top = 'zebra-templates-1a2b3c4';
  mkdirSync(join(staging, top));
  writeFileSync(
    join(staging, top, 'package.json'),
    JSON.stringify({ name: 'template', dependencies: { 'is-number': '^7.0.0' } })
  );
  const file = join(staging, 'archive.tgz');
  await createTar({ gzip: true, file, cwd: staging, portable: true }, [top]);
  return readFileSync(file);
}

function serve(body: Buffer): typeof fetch {
  return async () =>
    new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
}

/** What a JavaScript caller, which no type stops, can pass as a payload. */
function untyped(value: unknown): TelemetryPayload {
  return value as TelemetryPayload;
}

function recorder(): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (input, init) => {
      sent.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Sent['body'],
      });
      return new Response('{}');
    },
  };
}

const spec = {
  preset: 'rag',
  provider: 'openai' as const,
  memory: 'postgres' as const,
  features: ['rag' as const, 'evals' as const],
  packageManager: 'pnpm' as const,
};

describe('the payload', () => {
  it('holds exactly the listed fields and nothing a user typed', () => {
    const payload = payloadFor(spec);
    expect(Object.keys(payload).sort()).toEqual([...PAYLOAD_FIELDS].sort());
    expect(payload).toMatchObject({
      preset: 'rag',
      provider: 'openai',
      memory: 'postgres',
      features: 'rag,evals',
      packageManager: 'pnpm',
      node: process.versions.node.split('.')[0],
      os: process.platform,
      outcome: 'success',
      failedStep: 'none',
      errorCode: 'none',
    });
    expect(
      payloadFor(undefined, { step: 'create', error: new Error('x') }, 'template')
    ).toMatchObject({ preset: 'template', provider: 'none' });
  });

  it('says where and why a scaffold failed, never with the message', () => {
    const error = new CodedError('DIRECTORY_NOT_EMPTY', '/Users/zebra/app already exists');
    const payload = payloadFor(spec, { step: 'create', error });
    expect(payload).toMatchObject({
      outcome: 'failure',
      failedStep: 'create',
      errorCode: 'DIRECTORY_NOT_EMPTY',
    });
    expect(JSON.stringify(payload)).not.toContain('zebra');
  });
});

describe('the error code', () => {
  const fetchFailed = new TypeError('fetch failed', {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND registry.zebra.dev'), {
      code: 'ENOTFOUND',
    }),
  });

  it.each([
    ['a coded error', new CodedError('HTTP_404', 'not found'), 'HTTP_404'],
    [
      'a Node system error',
      Object.assign(new Error('EACCES: /zebra'), { code: 'EACCES' }),
      'EACCES',
    ],
    ['the cause of a failed fetch', fetchFailed, 'ENOTFOUND'],
    ['options that do not fit', new IncompatibleSpecError([]), 'INCOMPATIBLE_SPEC'],
    ['a timeout', new DOMException('The operation timed out', 'TimeoutError'), 'TIMEOUT_ERROR'],
    ['a bug', new TypeError("Cannot read properties of undefined (reading 'zebra')"), 'TYPE_ERROR'],
    ['a plain error', new Error('/Users/zebra/app is broken'), 'UNKNOWN'],
    ['a code that is not one', Object.assign(new Error('x'), { code: '/Users/zebra' }), 'UNKNOWN'],
    ['a thrown string', 'zebra', 'UNKNOWN'],
  ])('of %s is %s', (_name, error, code) => {
    expect(telemetryErrorCode(error)).toBe(code);
  });
});

describe('turning it off', () => {
  const base = { websiteId: 'site', env: {} };
  it.each([
    [{ flag: false }, '--no-telemetry'],
    [{ env: { COGITATOR_TELEMETRY_DISABLED: '1' } }, 'COGITATOR_TELEMETRY_DISABLED'],
    [{ env: { DO_NOT_TRACK: '1' } }, 'DO_NOT_TRACK'],
    [{ env: { CI: 'true' } }, 'CI'],
    [{ dryRun: true }, '--dry-run'],
    [{ websiteId: '' }, 'this build has no telemetry configured'],
  ])('%j turns it off', (options, reason) => {
    expect(telemetryDisabledReason({ ...base, ...options })).toBe(reason);
  });

  it('is on otherwise, also with DO_NOT_TRACK=0', () => {
    expect(
      telemetryDisabledReason({ ...base, env: { DO_NOT_TRACK: '0', CI: 'false' } })
    ).toBeUndefined();
  });
});

describe('sending', () => {
  it('posts one Umami event with the payload as its data', async () => {
    const { fetch, sent } = recorder();
    expect(await sendTelemetry(payloadFor(spec), { fetch, websiteId: 'site' })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://analytics.el1fe.com/api/send');
    expect(sent[0].body).toMatchObject({
      type: 'event',
      payload: { website: 'site', name: 'scaffold' },
    });
    expect(Object.keys(sent[0].body.payload.data).sort()).toEqual([...PAYLOAD_FIELDS].sort());
    expect(sent[0].headers['user-agent']).toBe(telemetryUserAgent(payloadFor(spec)));
  });

  it.each(['darwin', 'linux', 'win32', 'freebsd'])(
    'sends a User-Agent from %s that Umami does not take for a bot',
    (os) => {
      const userAgent = telemetryUserAgent({ os, version: '0.5.2' });
      expect(userAgent).toContain('create-cogitator-app/0.5.2');
      expect(isbot(userAgent), `${userAgent} matches ${isbotMatches(userAgent).join(', ')}`).toBe(
        false
      );
    }
  );

  it('never throws and gives up at its timeout', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('offline');
    };
    expect(await sendTelemetry(payloadFor(spec), { fetch: failing, websiteId: 'site' })).toBe(
      false
    );

    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      );
    const started = Date.now();
    expect(
      await sendTelemetry(payloadFor(spec), {
        fetch: hanging,
        websiteId: 'site',
        timeoutMs: 50,
      })
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['a buffer', { type: 'Buffer', data: [116, 101, 115, 116] }],
    [
      'a callback and a token',
      { url: 'http://127.0.0.1:9/callback', token: 'test', path: '/tmp/test' },
    ],
    ['a command', { command: 'init', args: [] }],
    ['an event with another field', { ...payloadFor(spec), token: 'test' }],
    ['an event with a path in it', { ...payloadFor(spec), preset: '/Users/zebra/app' }],
    ['an event without a field', { ...payloadFor(spec), errorCode: undefined }],
  ])('sends nothing for %s, whatever a JavaScript caller hands it', async (_name, value) => {
    const { fetch, sent } = recorder();
    expect(await sendTelemetry(untyped(value), { fetch, websiteId: 'site' })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends nothing without a website', async () => {
    const { fetch, sent } = recorder();
    expect(await sendTelemetry(payloadFor(spec), { fetch, websiteId: '' })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('the first-run notice', () => {
  it('is shown once', () => {
    const env = { XDG_CONFIG_HOME: temp() };
    expect(firstRunNotice(env)).toContain('--no-telemetry');
    expect(firstRunNotice(env)).toBeUndefined();
  });
});

describe('the scaffolder', () => {
  async function scaffoldWith(extra: string[], env: NodeJS.ProcessEnv) {
    const { fetch, sent } = recorder();
    let stderr = '';
    const directory = join(temp(), 'zebra-secret-project');
    const code = await run(
      [
        directory,
        '--preset',
        'basic',
        '--provider',
        'openai',
        '--pm',
        'pnpm',
        '--no-install',
        '--no-git',
        '--yes',
        ...extra,
      ],
      { stdout: () => undefined, stderr: (text) => (stderr += text) },
      { env, telemetry: { websiteId: 'site', fetch } }
    );
    return { code, sent, stderr };
  }

  it('sends one event per run and shows the notice the first time', async () => {
    const config = temp();
    const first = await scaffoldWith([], { XDG_CONFIG_HOME: config });
    expect(first.code).toBe(0);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0].body.payload.data).toMatchObject({
      preset: 'basic',
      provider: 'openai',
      outcome: 'success',
    });
    expect(JSON.stringify(first.sent[0].body)).not.toContain('zebra');
    expect(first.stderr).toContain('sends one anonymous event');

    const second = await scaffoldWith([], { XDG_CONFIG_HOME: config });
    expect(second.sent).toHaveLength(1);
    expect(second.stderr).not.toContain('sends one anonymous event');
  });

  it.each([
    [['--no-telemetry'], {}],
    [[], { COGITATOR_TELEMETRY_DISABLED: '1' }],
    [[], { DO_NOT_TRACK: '1' }],
    [[], { CI: 'true' }],
    [['--dry-run'], {}],
  ])('sends nothing with %j %j', async (flags, env) => {
    const result = await scaffoldWith(flags, { XDG_CONFIG_HOME: temp(), ...env });
    expect(result.code).toBe(0);
    expect(result.sent).toEqual([]);
    expect(result.stderr).not.toContain('sends one anonymous event');
  });

  it('reports a failed scaffold', async () => {
    const result = await scaffoldWith(
      ['--app', 'server', '--server', 'tetsu', '--memory', 'sqlite'],
      {
        XDG_CONFIG_HOME: temp(),
      }
    );
    expect(result.code).toBe(1);
    expect(result.sent.map((event) => event.body.payload.data)).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        failedStep: 'create',
        errorCode: 'INCOMPATIBLE_SPEC',
      }),
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('the reported failure', () => {
  const path = process.env.PATH;

  afterEach(() => {
    process.env.PATH = path;
    vi.unstubAllEnvs();
  });

  /** Puts a pnpm on PATH whose install fails the way pnpm does for a version not published yet. */
  function failingPnpm(): void {
    const bin = temp();
    writeFileSync(
      join(bin, 'pnpm'),
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo 11.0.0; exit 0; fi',
        `cat <<'OUT'`,
        readFileSync(join(FIXTURES, 'pnpm-no-version.txt'), 'utf-8').trimEnd(),
        'OUT',
        'exit 1',
      ].join('\n')
    );
    chmodSync(join(bin, 'pnpm'), 0o755);
    process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
    vi.stubEnv('npm_execpath', undefined);
  }

  async function runWith(argv: string[], download?: typeof fetch) {
    const { fetch, sent } = recorder();
    const code = await run(
      [join(temp(), 'zebra-secret-project'), '--pm', 'pnpm', '--no-git', '--yes', ...argv],
      { stdout: () => undefined, stderr: () => undefined },
      {
        env: { XDG_CONFIG_HOME: temp() },
        ...(download && { fetch: download }),
        telemetry: { websiteId: 'site', fetch },
      }
    );
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].body)).not.toContain('zebra');
    return { code, data: sent[0].body.payload.data };
  }

  it('is the install step and the code pnpm failed with', async () => {
    failingPnpm();
    const { code, data } = await runWith(['--preset', 'basic', '--provider', 'openai']);
    expect(code).toBe(0);
    expect(data).toMatchObject({
      outcome: 'failure',
      failedStep: 'install',
      errorCode: 'ERR_PNPM_NO_MATCHING_VERSION',
    });
  });

  it('is the install step of a copied template too', async () => {
    failingPnpm();
    const { code, data } = await runWith(
      ['--template', 'github:zebra-org/zebra-templates'],
      serve(await templateArchive())
    );
    expect(code).toBe(0);
    expect(data).toMatchObject({
      preset: 'template',
      outcome: 'failure',
      failedStep: 'install',
      errorCode: 'ERR_PNPM_NO_MATCHING_VERSION',
    });
  });

  it('is the create step and the HTTP status of a template that cannot be downloaded', async () => {
    const { code, data } = await runWith(
      ['--template', 'github:zebra-org/zebra-templates'],
      async () => new Response('Not Found', { status: 404 })
    );
    expect(code).toBe(1);
    expect(data).toMatchObject({
      preset: 'template',
      outcome: 'failure',
      failedStep: 'create',
      errorCode: 'HTTP_404',
    });
  });

  it('is the create step of a directory that is taken', async () => {
    const directory = join(temp(), 'zebra-taken');
    mkdirSync(directory);
    writeFileSync(join(directory, 'notes.md'), 'mine\n');
    const { fetch, sent } = recorder();
    const code = await run(
      [directory, '--preset', 'basic', '--provider', 'openai', '--no-install', '--yes'],
      { stdout: () => undefined, stderr: () => undefined },
      { env: { XDG_CONFIG_HOME: temp() }, telemetry: { websiteId: 'site', fetch } }
    );
    expect(code).toBe(1);
    expect(sent.map((event) => event.body.payload.data)).toEqual([
      expect.objectContaining({ failedStep: 'create', errorCode: 'DIRECTORY_NOT_EMPTY' }),
    ]);
    expect(JSON.stringify(sent)).not.toContain('zebra');
  });
});

describe('the telemetry docs', () => {
  it('list exactly the fields the event holds', () => {
    const page = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../dashboard/content/docs/getting-started/telemetry.mdx'
      ),
      'utf-8'
    );
    const documented = [...page.matchAll(/^\| `(\w+)` \|/gm)].map((match) => match[1]);
    expect(documented).toEqual([...PAYLOAD_FIELDS]);
    expect(page).toContain('src/kit/telemetry.ts');
  });
});
