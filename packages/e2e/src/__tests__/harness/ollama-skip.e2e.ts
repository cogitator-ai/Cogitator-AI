import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface TagsServer {
  url: string;
  tagRequests: number;
  close(): Promise<void>;
}

async function startTagsServer(answer: { status?: number; body: string }): Promise<TagsServer> {
  const state = { tagRequests: 0 };
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') state.tagRequests++;
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get tagRequests() {
      return state.tagRequests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function tags(...names: string[]): { body: string } {
  return { body: JSON.stringify({ models: names.map((name) => ({ name, model: name })) }) };
}

async function loadSetup(env: { TEST_OLLAMA?: string; OLLAMA_URL: string; TEST_MODEL?: string }) {
  vi.resetModules();
  vi.stubEnv('TEST_OLLAMA', env.TEST_OLLAMA ?? 'true');
  vi.stubEnv('OLLAMA_URL', env.OLLAMA_URL);
  vi.stubEnv('TEST_MODEL', env.TEST_MODEL ?? 'qwen2.5:0.5b');
  return import('../../helpers/setup');
}

describe('e2e harness: Ollama skip reason', () => {
  const servers: TagsServer[] = [];
  let closedUrl: string;

  const serve = async (answer: { status?: number; body: string }) => {
    const server = await startTagsServer(answer);
    servers.push(server);
    return server;
  };

  beforeAll(async () => {
    const gone = await startTagsServer(tags());
    closedUrl = gone.url;
    await gone.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
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
    const { ollamaSkipReason } = await loadSetup({ OLLAMA_URL: closedUrl });

    expect(await ollamaSkipReason()).toBe(`Ollama is not reachable at ${closedUrl}`);
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

  it('ollamaHasModel checks any model regardless of TEST_OLLAMA', async () => {
    const server = await serve(tags('nomic-embed-text:latest'));
    const { ollamaHasModel } = await loadSetup({ TEST_OLLAMA: '', OLLAMA_URL: server.url });

    expect(await ollamaHasModel('nomic-embed-text')).toBe(true);
    expect(await ollamaHasModel('qwen2.5:0.5b')).toBe(false);
  });
});
