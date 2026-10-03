import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { BrowserSession } from '../session';
import {
  createWaitForResponseTool,
  createCaptureHarTool,
  createGetApiCallsTool,
  createInterceptRequestTool,
  createRemoveInterceptorTool,
  createBlockResourcesTool,
  createNetworkTools,
  toUrlMatcher,
} from '../tools/network';

type Listener = (arg: unknown) => void;
type RouteHandler = (route: unknown) => Promise<void>;

interface MockRequestOptions {
  url: string;
  method?: string;
  type?: string;
  status?: number;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  body?: string | Buffer;
  bodyGate?: Promise<void>;
  postData?: string | null;
  responseEnd?: number;
  startTime?: number;
  failure?: string;
}

function mockRequest(opts: MockRequestOptions) {
  const response = {
    status: () => opts.status ?? 200,
    statusText: () => 'OK',
    headers: () => opts.responseHeaders ?? { 'content-type': 'application/json' },
    body: async () => {
      await opts.bodyGate;
      return Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body ?? '{}');
    },
  };
  return {
    url: () => opts.url,
    method: () => opts.method ?? 'GET',
    resourceType: () => opts.type ?? 'fetch',
    headers: () => opts.headers ?? { accept: '*/*' },
    postData: () => opts.postData ?? null,
    timing: () => ({
      startTime: opts.startTime ?? Date.UTC(2026, 9, 2, 12, 0, 0),
      responseEnd: opts.responseEnd ?? 42.5,
    }),
    response: async () => (opts.failure ? null : response),
    failure: () => (opts.failure ? { errorText: opts.failure } : null),
  };
}

function createMockContext() {
  const listeners = new Map<string, Listener[]>();
  const routes: Array<{ pattern: string | RegExp; handler: RouteHandler }> = [];
  const started = new WeakSet<object>();
  return {
    listeners,
    routes,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    emit(event: string, arg: unknown) {
      const isCompletion = event === 'requestfinished' || event === 'requestfailed';
      if (isCompletion && !started.has(arg as object)) {
        this.emit('request', arg);
      }
      if (event === 'request') started.add(arg as object);
      for (const listener of listeners.get(event) ?? []) listener(arg);
    },
    route: vi.fn(async (pattern: string | RegExp, handler: RouteHandler) => {
      routes.push({ pattern, handler });
    }),
    unroute: vi.fn(async (pattern: string | RegExp, handler: RouteHandler) => {
      const idx = routes.findIndex((r) => r.pattern === pattern && r.handler === handler);
      if (idx !== -1) routes.splice(idx, 1);
    }),
  };
}

function createMockSession() {
  const startListeners = new Set<(ctx: unknown) => void>();
  const mockPage = {
    waitForResponse: vi.fn().mockResolvedValue({
      url: () => 'https://api.example.com/data',
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"data": true}'),
    }),
  };
  const state = { context: createMockContext() };
  const session = {
    page: mockPage,
    get context() {
      return state.context;
    },
    onStart(listener: (ctx: unknown) => void) {
      startListeners.add(listener);
      listener(state.context);
      return () => startListeners.delete(listener);
    },
  };
  return {
    session: session as unknown as BrowserSession,
    mockPage,
    state,
    restart() {
      state.context = createMockContext();
      for (const listener of startListeners) listener(state.context);
    },
  };
}

type NetworkTool = ReturnType<typeof createNetworkTools>[number];
type HarResult = Awaited<ReturnType<ReturnType<typeof createCaptureHarTool>['execute']>>;

function networkTool<T extends NetworkTool>(
  tools: NetworkTool[],
  factory: (session: BrowserSession) => T,
  session: BrowserSession
): T {
  const { name } = factory(session);
  const found = tools.find((t): t is T => t.name === name);
  if (!found) throw new Error(`createNetworkTools does not include ${name}`);
  return found;
}

function stoppedHar(result: HarResult): Extract<HarResult, { har: unknown }> {
  if (!('har' in result)) throw new Error('Expected the result of a stopped HAR capture');
  return result;
}

function mockRoute(request = mockRequest({ url: 'https://x.test/a', type: 'image' })) {
  return {
    abort: vi.fn().mockResolvedValue(undefined),
    continue: vi.fn().mockResolvedValue(undefined),
    fallback: vi.fn().mockResolvedValue(undefined),
    request: () => request,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const dummyContext = {
  agentId: 'test',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('network tools', () => {
  let mock: ReturnType<typeof createMockSession>;
  let session: BrowserSession;

  beforeEach(() => {
    mock = createMockSession();
    session = mock.session;
  });

  describe('toUrlMatcher', () => {
    it('keeps globs as strings', () => {
      expect(toUrlMatcher('**/api/**')).toBe('**/api/**');
    });

    it('compiles /regex/flags literals without stateful flags', () => {
      const matcher = toUrlMatcher('/\\.png$/gi');
      expect(matcher).toBeInstanceOf(RegExp);
      expect((matcher as RegExp).flags).toBe('i');
      expect((matcher as RegExp).test('https://x.test/A.PNG')).toBe(true);
      expect((matcher as RegExp).test('https://x.test/A.PNG')).toBe(true);
    });

    it('throws a descriptive error for invalid regex literals', () => {
      expect(() => toUrlMatcher('/([a-/')).toThrow('Invalid regular expression in urlPattern');
    });
  });

  describe('browser_intercept_request', () => {
    it('has correct shape and schema', () => {
      const t = createInterceptRequestTool(session);
      expect(t.name).toBe('browser_intercept_request');
      expect(t.category).toBe('web');
      expect(t.tags).toEqual(expect.arrayContaining(['browser', 'network']));
      const json = t.toJSON();
      expect(json.parameters.properties).toHaveProperty('urlPattern');
      expect(json.parameters.properties).toHaveProperty('action');
    });

    it('registers the route on the browser context so it applies to every tab', async () => {
      const t = createInterceptRequestTool(session);
      const result = await t.execute({ urlPattern: '**/ads/**', action: 'block' }, dummyContext);

      expect(result.interceptorId).toBe('interceptor_1');
      expect(mock.state.context.route).toHaveBeenCalledWith('**/ads/**', expect.any(Function));

      const route = mockRoute();
      await mock.state.context.routes[0].handler(route);
      expect(route.abort).toHaveBeenCalled();
      expect(route.fallback).not.toHaveBeenCalled();
    });

    it('passes regex literal patterns as RegExp', async () => {
      const t = createInterceptRequestTool(session);
      await t.execute({ urlPattern: '/tracker\\.js$/', action: 'block' }, dummyContext);

      const pattern = mock.state.context.routes[0].pattern;
      expect(pattern).toBeInstanceOf(RegExp);
      expect((pattern as RegExp).source).toBe('tracker\\.js$');
    });

    it('merges modified headers with the original request headers and falls back', async () => {
      const t = createInterceptRequestTool(session);
      await t.execute(
        {
          urlPattern: '**/api/**',
          action: 'modify',
          modify: {
            headers: { Authorization: 'Bearer token' },
            body: '{"modified": true}',
            url: 'https://new-api.example.com/data',
          },
        },
        dummyContext
      );

      const route = mockRoute(
        mockRequest({ url: 'https://api.test/x', headers: { 'user-agent': 'UA', cookie: 'a=1' } })
      );
      await mock.state.context.routes[0].handler(route);
      expect(route.continue).not.toHaveBeenCalled();
      expect(route.fallback).toHaveBeenCalledWith({
        headers: { 'user-agent': 'UA', cookie: 'a=1', Authorization: 'Bearer token' },
        postData: '{"modified": true}',
        url: 'https://new-api.example.com/data',
      });
    });

    it('forwards an empty replacement body', async () => {
      const t = createInterceptRequestTool(session);
      await t.execute({ urlPattern: '**/*', action: 'modify', modify: { body: '' } }, dummyContext);

      const route = mockRoute();
      await mock.state.context.routes[0].handler(route);
      expect(route.fallback).toHaveBeenCalledWith({ postData: '' });
    });

    it('uses fallback for continue so other interceptors still run', async () => {
      const t = createInterceptRequestTool(session);
      await t.execute({ urlPattern: '**/*', action: 'continue' }, dummyContext);

      const route = mockRoute();
      await mock.state.context.routes[0].handler(route);
      expect(route.fallback).toHaveBeenCalledWith();
      expect(route.continue).not.toHaveBeenCalled();
    });

    it('returns a warning instead of registering when modify object is missing', async () => {
      const t = createInterceptRequestTool(session);
      const result = await t.execute({ urlPattern: '**/*', action: 'modify' }, dummyContext);

      expect(result.interceptorId).toBeNull();
      expect(result.warning).toContain('modify');
      expect(mock.state.context.route).not.toHaveBeenCalled();
    });

    it('increments interceptor IDs across intercept and block tools', async () => {
      const tools = createNetworkTools(session);
      const intercept = networkTool(tools, createInterceptRequestTool, session);
      const block = networkTool(tools, createBlockResourcesTool, session);
      const r1 = await intercept.execute({ urlPattern: '**/a', action: 'block' }, dummyContext);
      const r2 = await block.execute({ types: ['image'] }, dummyContext);

      expect(r1.interceptorId).toBe('interceptor_1');
      expect(r2.interceptorId).toBe('interceptor_2');
    });

    it('throws when the session has not started', async () => {
      const t = createInterceptRequestTool(session);
      mock.state.context = null as never;
      await expect(
        t.execute({ urlPattern: '**/*', action: 'block' }, dummyContext)
      ).rejects.toThrow('BrowserSession not started');
    });
  });

  describe('browser_remove_interceptor', () => {
    it('removes a single interceptor by id', async () => {
      const intercept = createInterceptRequestTool(session);
      const remove = createRemoveInterceptorTool(session);
      const { interceptorId } = await intercept.execute(
        { urlPattern: '**/a', action: 'block' },
        dummyContext
      );

      const result = await remove.execute({ interceptorId: interceptorId! }, dummyContext);

      expect(result.removed).toEqual([interceptorId]);
      expect(mock.state.context.unroute).toHaveBeenCalledWith('**/a', expect.any(Function));
      expect(mock.state.context.routes).toHaveLength(0);
    });

    it('returns an empty list for unknown ids', async () => {
      const remove = createRemoveInterceptorTool(session);
      const result = await remove.execute({ interceptorId: 'interceptor_404' }, dummyContext);
      expect(result.removed).toEqual([]);
    });

    it('removes all interceptors when no id is given', async () => {
      const tools = createNetworkTools(session);
      const intercept = networkTool(tools, createInterceptRequestTool, session);
      const block = networkTool(tools, createBlockResourcesTool, session);
      const remove = createRemoveInterceptorTool(session);
      await intercept.execute({ urlPattern: '**/a', action: 'block' }, dummyContext);
      await block.execute({ types: ['font'] }, dummyContext);

      const result = await remove.execute({}, dummyContext);

      expect(result.removed).toEqual(['interceptor_1', 'interceptor_2']);
      expect(mock.state.context.routes).toHaveLength(0);
    });

    it('forgets interceptors of a previous browser context after restart', async () => {
      const intercept = createInterceptRequestTool(session);
      const remove = createRemoveInterceptorTool(session);
      await intercept.execute({ urlPattern: '**/a', action: 'block' }, dummyContext);

      mock.restart();
      const result = await remove.execute({}, dummyContext);
      expect(result.removed).toEqual([]);
    });
  });

  describe('browser_wait_for_response', () => {
    it('has correct shape', () => {
      const t = createWaitForResponseTool(session);
      expect(t.name).toBe('browser_wait_for_response');
      expect(t.tags).toContain('network');
    });

    it('returns url, status, headers, body', async () => {
      const t = createWaitForResponseTool(session);
      const result = await t.execute({ urlPattern: 'api.example.com' }, dummyContext);

      expect(result).toEqual({
        url: 'https://api.example.com/data',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"data": true}',
      });
    });

    it('passes timeout to waitForResponse', async () => {
      const t = createWaitForResponseTool(session);
      await t.execute({ urlPattern: 'api.example.com', timeout: 5000 }, dummyContext);

      expect(mock.mockPage.waitForResponse).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 5000,
      });
    });

    it('matches by substring', async () => {
      const t = createWaitForResponseTool(session);
      await t.execute({ urlPattern: 'api.example' }, dummyContext);

      const predicate = mock.mockPage.waitForResponse.mock.calls[0][0];
      expect(predicate({ url: () => 'https://api.example.com/data' })).toBe(true);
      expect(predicate({ url: () => 'https://other.com/data' })).toBe(false);
    });

    it('matches by regex literal', async () => {
      const t = createWaitForResponseTool(session);
      await t.execute({ urlPattern: '/\\/v\\d+\\/users$/' }, dummyContext);

      const predicate = mock.mockPage.waitForResponse.mock.calls[0][0];
      expect(predicate({ url: () => 'https://api.test/v2/users' })).toBe(true);
      expect(predicate({ url: () => 'https://api.test/v2/users/1' })).toBe(false);
    });

    it('returns empty body when text() throws', async () => {
      mock.mockPage.waitForResponse.mockResolvedValueOnce({
        url: () => 'https://api.example.com/binary',
        status: () => 200,
        headers: () => ({}),
        text: () => Promise.reject(new Error('binary')),
      });
      const t = createWaitForResponseTool(session);
      const result = await t.execute({ urlPattern: 'binary' }, dummyContext);
      expect(result.body).toBe('');
    });
  });

  describe('browser_block_resources', () => {
    it('routes every request on the context', async () => {
      const block = networkTool(createNetworkTools(session), createBlockResourcesTool, session);
      const result = await block.execute({ types: ['image', 'font'] }, dummyContext);

      expect(result).toEqual({
        blocking: true,
        interceptorId: 'interceptor_1',
        types: ['image', 'font'],
      });
      expect(mock.state.context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    });

    it('aborts blocked types and falls back for the rest', async () => {
      const block = networkTool(createNetworkTools(session), createBlockResourcesTool, session);
      await block.execute({ types: ['image'] }, dummyContext);
      const handler = mock.state.context.routes[0].handler;

      const image = mockRoute(mockRequest({ url: 'https://x.test/a.png', type: 'image' }));
      await handler(image);
      expect(image.abort).toHaveBeenCalled();

      const script = mockRoute(mockRequest({ url: 'https://x.test/a.js', type: 'script' }));
      await handler(script);
      expect(script.abort).not.toHaveBeenCalled();
      expect(script.fallback).toHaveBeenCalled();
      expect(script.continue).not.toHaveBeenCalled();
    });
  });

  describe('browser_capture_har', () => {
    let workDir: string;
    let cwd: string;

    beforeEach(async () => {
      cwd = process.cwd();
      workDir = await realpath(await mkdtemp(join(tmpdir(), 'cogitator-har-')));
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    it('captures finished and failed requests of all tabs with real timings', async () => {
      const har = createCaptureHarTool(session);
      expect(await har.execute({ action: 'start' }, dummyContext)).toEqual({
        capturing: true,
        entries: 0,
      });

      mock.state.context.emit(
        'requestfinished',
        mockRequest({
          url: 'https://api.test/data',
          method: 'POST',
          postData: '{"q":1}',
          body: '{"ok":true}',
          responseEnd: 87.25,
        })
      );
      mock.state.context.emit(
        'requestfailed',
        mockRequest({ url: 'https://cdn.test/a.js', type: 'script', failure: 'net::ERR_FAILED' })
      );
      await flush();

      const result = stoppedHar(await har.execute({ action: 'stop' }, dummyContext));
      expect(result.capturing).toBe(false);
      expect(result.entries).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.har[0]).toEqual({
        url: 'https://api.test/data',
        method: 'POST',
        status: 200,
        timing: 87.25,
        requestHeaders: { accept: '*/*' },
        responseHeaders: { 'content-type': 'application/json' },
        requestBody: '{"q":1}',
        responseBody: '{"ok":true}',
      });
      expect(result.har[1]).toMatchObject({ url: 'https://cdn.test/a.js', status: 0 });
    });

    it('waits for pending body reads on stop', async () => {
      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);

      let release!: () => void;
      const bodyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mock.state.context.emit(
        'requestfinished',
        mockRequest({ url: 'https://api.test/slow', bodyGate, body: '"slow"' })
      );

      const stopping = har.execute({ action: 'stop' }, dummyContext);
      setTimeout(release, 5);
      const result = stoppedHar(await stopping);

      expect(result.entries).toBe(1);
      expect(result.har[0].responseBody).toBe('"slow"');
    });

    it('orders entries by request start and waits briefly for in-flight requests on stop', async () => {
      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);

      const first = mockRequest({ url: 'https://api.test/first' });
      const second = mockRequest({ url: 'https://api.test/second' });
      mock.state.context.emit('request', first);
      mock.state.context.emit('request', second);
      mock.state.context.emit('requestfinished', second);

      const stopping = har.execute({ action: 'stop' }, dummyContext);
      setTimeout(() => mock.state.context.emit('requestfinished', first), 10);
      const result = stoppedHar(await stopping);

      expect(result.har.map((e: { url: string }) => e.url)).toEqual([
        'https://api.test/first',
        'https://api.test/second',
      ]);
    });

    it('drops requests that are still in flight after the settle timeout', async () => {
      vi.useFakeTimers();
      try {
        const har = createCaptureHarTool(session);
        await har.execute({ action: 'start' }, dummyContext);
        mock.state.context.emit('request', mockRequest({ url: 'https://api.test/stream' }));
        mock.state.context.emit('requestfinished', mockRequest({ url: 'https://api.test/done' }));

        const stopping = har.execute({ action: 'stop' }, dummyContext);
        await vi.advanceTimersByTimeAsync(2000);
        const result = stoppedHar(await stopping);

        expect(result.har.map((e: { url: string }) => e.url)).toEqual(['https://api.test/done']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores requests that started before the capture began', async () => {
      const early = mockRequest({ url: 'https://api.test/early' });
      mock.state.context.emit('request', early);

      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);
      mock.state.context.emit('requestfinished', early);
      await flush();

      const result = await har.execute({ action: 'stop' }, dummyContext);
      expect(result.entries).toBe(0);
    });

    it('does not leak entries from a stopped capture into the next one', async () => {
      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);
      await har.execute({ action: 'stop' }, dummyContext);

      mock.state.context.emit('requestfinished', mockRequest({ url: 'https://api.test/late' }));
      await flush();

      await har.execute({ action: 'start' }, dummyContext);
      const result = await har.execute({ action: 'stop' }, dummyContext);
      expect(result.entries).toBe(0);
    });

    it('restarting a capture resets entries without duplicating listeners', async () => {
      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);
      mock.state.context.emit('requestfinished', mockRequest({ url: 'https://api.test/1' }));
      await flush();
      await har.execute({ action: 'start' }, dummyContext);
      mock.state.context.emit('requestfinished', mockRequest({ url: 'https://api.test/2' }));
      await flush();

      const result = stoppedHar(await har.execute({ action: 'stop' }, dummyContext));
      expect(result.har.map((e: { url: string }) => e.url)).toEqual(['https://api.test/2']);
      expect(mock.state.context.listeners.get('requestfinished')).toHaveLength(1);
    });

    it('omits binary response bodies', async () => {
      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);
      mock.state.context.emit(
        'requestfinished',
        mockRequest({
          url: 'https://cdn.test/logo.png',
          type: 'image',
          responseHeaders: { 'content-type': 'image/png' },
          body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        })
      );
      await flush();

      const result = stoppedHar(await har.execute({ action: 'stop' }, dummyContext));
      expect(result.har[0]).not.toHaveProperty('responseBody');
    });

    it('returns zero entries when stopped without starting', async () => {
      const har = createCaptureHarTool(session);
      const result = await har.execute({ action: 'stop' }, dummyContext);
      expect(result).toEqual({ capturing: false, entries: 0, truncated: false, har: [] });
    });

    it('writes a valid HAR 1.2 document inside the working directory', async () => {
      process.chdir(workDir);
      try {
        const har = createCaptureHarTool(session);
        await har.execute({ action: 'start' }, dummyContext);
        mock.state.context.emit(
          'requestfinished',
          mockRequest({
            url: 'https://api.test/search?q=cats&page=2',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            postData: '{"a":1}',
            responseHeaders: { 'content-type': 'application/json', location: '/next' },
            body: '[]',
          })
        );
        await flush();

        const result = stoppedHar(
          await har.execute({ action: 'stop', path: 'out.har' }, dummyContext)
        );
        expect(relative(workDir, result.path!)).toBe('out.har');

        const doc = JSON.parse(await readFile(join(workDir, 'out.har'), 'utf-8'));
        expect(doc.log.version).toBe('1.2');
        expect(doc.log.creator.name).toBe('@cogitator-ai/browser');
        const entry = doc.log.entries[0];
        expect(entry.startedDateTime).toBe('2026-10-02T12:00:00.000Z');
        expect(entry.time).toBe(42.5);
        expect(entry.request.queryString).toEqual([
          { name: 'q', value: 'cats' },
          { name: 'page', value: '2' },
        ]);
        expect(entry.request.postData).toEqual({ mimeType: 'application/json', text: '{"a":1}' });
        expect(entry.response.content).toEqual({
          size: 2,
          mimeType: 'application/json',
          text: '[]',
        });
        expect(entry.response.redirectURL).toBe('/next');
        expect(entry.response.headers).toContainEqual({
          name: 'content-type',
          value: 'application/json',
        });
      } finally {
        process.chdir(cwd);
      }
    });

    it('rejects output paths outside the working directory', async () => {
      const har = createCaptureHarTool(session);
      await har.execute({ action: 'start' }, dummyContext);
      await expect(
        har.execute({ action: 'stop', path: '../escape.har' }, dummyContext)
      ).rejects.toThrow('within the working directory');
    });
  });

  describe('browser_get_api_calls', () => {
    it('records xhr/fetch calls made before the tool is first called', async () => {
      const t = createGetApiCallsTool(session);
      mock.state.context.emit(
        'requestfinished',
        mockRequest({ url: 'https://api.test/users', type: 'xhr', responseEnd: 15 })
      );
      mock.state.context.emit(
        'requestfinished',
        mockRequest({ url: 'https://cdn.test/app.css', type: 'stylesheet' })
      );
      await flush();

      const result = await t.execute({}, dummyContext);
      expect(result.calls).toEqual([
        {
          url: 'https://api.test/users',
          method: 'GET',
          status: 200,
          timing: 15,
          requestHeaders: { accept: '*/*' },
          responseHeaders: { 'content-type': 'application/json' },
        },
      ]);
    });

    it('records failed API calls with the error text', async () => {
      const t = createGetApiCallsTool(session);
      mock.state.context.emit(
        'requestfailed',
        mockRequest({ url: 'https://api.test/down', failure: 'net::ERR_CONNECTION_REFUSED' })
      );
      await flush();

      const result = await t.execute({}, dummyContext);
      expect(result.calls[0]).toMatchObject({
        url: 'https://api.test/down',
        status: 0,
        error: 'net::ERR_CONNECTION_REFUSED',
      });
    });

    it('filters by url substring, regex literal and method', async () => {
      const t = createGetApiCallsTool(session);
      for (const [url, method] of [
        ['https://api.test/v1/users', 'GET'],
        ['https://api.test/v1/users', 'POST'],
        ['https://api.test/v2/posts', 'GET'],
      ]) {
        mock.state.context.emit('requestfinished', mockRequest({ url, method }));
      }
      await flush();

      expect((await t.execute({ urlPattern: '/users' }, dummyContext)).calls).toHaveLength(2);
      expect((await t.execute({ urlPattern: '/\\/v2\\//' }, dummyContext)).calls).toHaveLength(1);
      expect((await t.execute({ method: 'post' }, dummyContext)).calls).toHaveLength(1);
      const both = await t.execute({ urlPattern: 'users', method: 'GET' }, dummyContext);
      expect(both.calls).toHaveLength(1);
      expect(both.calls[0].method).toBe('GET');
    });

    it('clears recorded calls when requested', async () => {
      const t = createGetApiCallsTool(session);
      mock.state.context.emit('requestfinished', mockRequest({ url: 'https://api.test/a' }));
      await flush();

      expect((await t.execute({ clear: true }, dummyContext)).calls).toHaveLength(1);
      expect((await t.execute({}, dummyContext)).calls).toHaveLength(0);
    });

    it('keeps only the most recent 1000 calls', async () => {
      const t = createGetApiCallsTool(session);
      for (let i = 0; i < 1005; i++) {
        mock.state.context.emit('requestfinished', mockRequest({ url: `https://api.test/${i}` }));
      }
      await flush();

      const { calls } = await t.execute({}, dummyContext);
      expect(calls).toHaveLength(1000);
      expect(calls[0].url).toBe('https://api.test/5');
    });

    it('shares recorded calls between tool instances of the same session', async () => {
      const first = createGetApiCallsTool(session);
      const second = networkTool(createNetworkTools(session), createGetApiCallsTool, session);
      mock.state.context.emit('requestfinished', mockRequest({ url: 'https://api.test/shared' }));
      await flush();

      expect((await first.execute({}, dummyContext)).calls).toHaveLength(1);
      expect((await second.execute({}, dummyContext)).calls).toHaveLength(1);
      expect(mock.state.context.listeners.get('requestfinished')).toHaveLength(1);
    });
  });

  describe('createNetworkTools', () => {
    it('returns all 6 tools in order', () => {
      const tools = createNetworkTools(session);
      expect(tools.map((t) => t.name)).toEqual([
        'browser_intercept_request',
        'browser_wait_for_response',
        'browser_block_resources',
        'browser_capture_har',
        'browser_get_api_calls',
        'browser_remove_interceptor',
      ]);
    });

    it('all tools share category and tag and serialize to JSON', () => {
      for (const t of createNetworkTools(session)) {
        expect(t.category).toBe('web');
        expect(t.tags).toContain('network');
        const json = t.toJSON();
        expect(json.name).toBe(t.name);
        expect(json.parameters.type).toBe('object');
      }
    });
  });
});
