import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../cli/main.js';
import {
  firstRunNotice,
  PAYLOAD_FIELDS,
  payloadFor,
  sendTelemetry,
  telemetryDisabledReason,
} from '../kit/telemetry.js';

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
    const payload = payloadFor(spec, 'success');
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
    });
    expect(payloadFor(undefined, 'failure', 'template')).toMatchObject({
      preset: 'template',
      provider: 'none',
    });
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
    expect(await sendTelemetry(payloadFor(spec, 'success'), { fetch, websiteId: 'site' })).toBe(
      true
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://analytics.el1fe.com/api/send');
    expect(sent[0].body).toMatchObject({
      type: 'event',
      payload: { website: 'site', name: 'scaffold' },
    });
    expect(Object.keys(sent[0].body.payload.data).sort()).toEqual([...PAYLOAD_FIELDS].sort());
    expect(sent[0].headers['user-agent']).toContain('create-cogitator-app/');
  });

  it('never throws and gives up at its timeout', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('offline');
    };
    expect(
      await sendTelemetry(payloadFor(spec, 'success'), { fetch: failing, websiteId: 'site' })
    ).toBe(false);

    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      );
    const started = Date.now();
    expect(
      await sendTelemetry(payloadFor(spec, 'success'), {
        fetch: hanging,
        websiteId: 'site',
        timeoutMs: 50,
      })
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('sends nothing without a website', async () => {
    const { fetch, sent } = recorder();
    expect(await sendTelemetry(payloadFor(spec, 'success'), { fetch, websiteId: '' })).toBe(false);
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
    expect(result.sent.map((event) => event.body.payload.data.outcome)).toEqual(['failure']);
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
