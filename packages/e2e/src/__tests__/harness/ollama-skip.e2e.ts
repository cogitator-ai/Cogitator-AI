import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface TagsServer {
  url: string;
  tagRequests: number;
  authorization: string | undefined;
  close(): Promise<void>;
}

async function startTagsServer(answer: { status?: number; body: string }): Promise<TagsServer> {
  const state: { tagRequests: number; authorization: string | undefined } = {
    tagRequests: 0,
    authorization: undefined,
  };
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      state.tagRequests++;
      state.authorization = req.headers.authorization;
    }
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  const url = await listen(server);
  return {
    url,
    get tagRequests() {
      return state.tagRequests;
    },
    get authorization() {
      return state.authorization;
    },
    close: () => close(server),
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function tags(...names: string[]): { body: string } {
  return { body: JSON.stringify({ models: names.map((name) => ({ name, model: name })) }) };
}

async function loadSetup(env: {
  TEST_OLLAMA?: string;
  OLLAMA_URL: string;
  TEST_MODEL?: string;
  OLLAMA_API_KEY?: string;
  CI?: string;
}) {
  vi.resetModules();
  vi.stubEnv('CI', env.CI ?? '');
  vi.stubEnv('OLLAMA_API_KEY', env.OLLAMA_API_KEY ?? '');
  vi.stubEnv('TEST_OLLAMA', env.TEST_OLLAMA ?? 'true');
  vi.stubEnv('OLLAMA_URL', env.OLLAMA_URL);
  vi.stubEnv('TEST_MODEL', env.TEST_MODEL ?? 'qwen2.5:0.5b');
  return import('../../helpers/setup');
}

describe('e2e harness: Ollama skip reason', () => {
  const servers: TagsServer[] = [];
  let hangUp: Server;
  let unreachableUrl: string;

  const serve = async (answer: { status?: number; body: string }) => {
    const server = await startTagsServer(answer);
    servers.push(server);
    return server;
  };

  beforeAll(async () => {
    hangUp = createServer();
    hangUp.on('connection', (socket) => socket.destroy());
    unreachableUrl = await listen(hangUp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all([...servers.map((s) => s.close()), close(hangUp)]);
  });

  it('runs when the test model is pulled', async () => {
    const server = await serve(tags('llama3.2:latest', 'qwen2.5:0.5b'));
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: server.url });

    expect(await ollamaSkipReason()).toBeNull();
  });

  it('skips with the pull command when the test model is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await serve(tags('llama3.2:latest'));
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: server.url });

    const reason = await ollamaSkipReason();

    expect(reason).toBe('model qwen2.5:0.5b is not pulled, run: ollama pull qwen2.5:0.5b');
    expect(warn).toHaveBeenCalledWith(`Skipping the Ollama e2e: ${reason}`);
  });

  it('matches an untagged test model against its :latest pull only', async () => {
    const latest = await serve(tags('gemma3:latest'));
    const sized = await serve(tags('gemma3:4b'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const withLatest = await loadSetup({ OLLAMA_URL: latest.url, TEST_MODEL: 'gemma3' });
    expect(await withLatest.ollamaSkipReason()).toBeNull();

    const withSized = await loadSetup({ OLLAMA_URL: sized.url, TEST_MODEL: 'gemma3' });
    expect(await withSized.ollamaSkipReason()).toMatch(/model gemma3 is not pulled/);
  });

  it('skips when Ollama is not reachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: unreachableUrl });

    expect(await ollamaSkipReason()).toBe(`Ollama is not reachable at ${unreachableUrl}`);
  });

  it('skips when /api/tags fails or answers something that is not JSON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = await serve({ status: 500, body: '{}' });
    const garbled = await serve({ body: '<html>' });

    const fromFailing = await loadSetup({ OLLAMA_URL: failing.url });
    expect(await fromFailing.ollamaSkipReason()).toBe(
      `Ollama at ${failing.url} answered /api/tags with 500`
    );

    const fromGarbled = await loadSetup({ OLLAMA_URL: garbled.url });
    expect(await fromGarbled.ollamaSkipReason()).toBe(
      `Ollama at ${garbled.url} answered /api/tags with invalid JSON`
    );
  });

  it('skips quietly without probing when TEST_OLLAMA is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await serve(tags('qwen2.5:0.5b'));
    const { ollamaSkipReason } = await loadSetup({ TEST_OLLAMA: '', OLLAMA_URL: server.url });

    expect(await ollamaSkipReason()).toBe('TEST_OLLAMA is not "true"');
    expect(server.tagRequests).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('probes Ollama once per test file and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await serve(tags());
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: server.url });

    const reasons = await Promise.all([ollamaSkipReason(), ollamaSkipReason()]);
    await ollamaSkipReason();

    expect(reasons[0]).toBe(reasons[1]);
    expect(server.tagRequests).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sends OLLAMA_API_KEY to an Ollama that asks for one, and nothing otherwise', async () => {
    const server = await serve(tags('qwen2.5:0.5b'));

    const keyed = await loadSetup({ OLLAMA_URL: server.url, OLLAMA_API_KEY: 'test-key' });
    expect(await keyed.ollamaSkipReason()).toBeNull();
    expect(server.authorization).toBe('Bearer test-key');

    const open = await loadSetup({ OLLAMA_URL: server.url });
    expect(await open.ollamaSkipReason()).toBeNull();
    expect(server.authorization).toBeUndefined();
  });

  it('fails instead of skipping when CI asked for the Ollama e2e and cannot run them', async () => {
    const server = await serve(tags('llama3.2:latest'));
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: server.url, CI: 'true' });

    await expect(ollamaSkipReason()).rejects.toThrow(
      'TEST_OLLAMA is "true" in CI, but model qwen2.5:0.5b is not pulled'
    );
  });

  it('still skips quietly in CI when TEST_OLLAMA is off', async () => {
    const { ollamaSkipReason } = await loadSetup({
      TEST_OLLAMA: '',
      OLLAMA_URL: unreachableUrl,
      CI: 'true',
    });

    expect(await ollamaSkipReason()).toBe('TEST_OLLAMA is not "true"');
  });

  it('keeps credentials in OLLAMA_URL out of the reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const credentialed = unreachableUrl.replace('http://', 'http://user:secret@');
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: credentialed });

    const reason = await ollamaSkipReason();

    expect(reason).toBe(`Ollama is not reachable at ${unreachableUrl}`);
    expect(reason).not.toContain('secret');
  });

  it('ollamaHasModel checks any model regardless of TEST_OLLAMA', async () => {
    const server = await serve(tags('nomic-embed-text:latest'));
    const { ollamaHasModel } = await loadSetup({ TEST_OLLAMA: '', OLLAMA_URL: server.url });

    expect(await ollamaHasModel('nomic-embed-text')).toBe(true);
    expect(await ollamaHasModel('qwen2.5:0.5b')).toBe(false);
  });
});
