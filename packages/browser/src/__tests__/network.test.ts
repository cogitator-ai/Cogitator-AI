import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserSession } from '../session';
import {
  createWaitForResponseTool,
  createCaptureHarTool,
  createNetworkTools,
} from '../tools/network';

type AnyFn = (...args: unknown[]) => unknown;

function createMockSession() {
  const listeners = new Map<string, AnyFn[]>();
  const routes = new Map<string, AnyFn>();

  const mockPage = {
    route: vi.fn().mockImplementation(async (pattern: string, handler: AnyFn) => {
      routes.set(pattern, handler);
    }),
    unroute: vi.fn().mockImplementation(async (pattern: string) => {
      routes.delete(pattern);
    }),
    waitForResponse: vi.fn().mockResolvedValue({
      url: () => 'https://api.example.com/data',
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"data": true}'),
    }),
    on: vi.fn().mockImplementation((event: string, handler: AnyFn) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    }),
    removeListener: vi.fn().mockImplementation((event: string, handler: AnyFn) => {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((h) => h !== handler)
      );
    }),
  };

  return {
    session: { page: mockPage } as unknown as BrowserSession,
    mockPage,
    listeners,
    routes,
  };
}

const dummyContext = {
  agentId: 'test',
  runId: 'test-run',
  signal: new AbortController().signal,
};

describe('network tools', () => {
  let session: BrowserSession;
  let mockPage: ReturnType<typeof createMockSession>['mockPage'];
  let listeners: ReturnType<typeof createMockSession>['listeners'];
  let routes: ReturnType<typeof createMockSession>['routes'];

  beforeEach(() => {
    const mock = createMockSession();
    session = mock.session;
    mockPage = mock.mockPage;
    listeners = mock.listeners;
    routes = mock.routes;
  });

  describe('createInterceptRequestTool', () => {
    it('has correct shape', () => {
      const tools = createNetworkTools(session);
      const t = tools[0];

      expect(t.name).toBe('browser_intercept_request');
      expect(t.description).toBeTruthy();
      expect(t.category).toBe('web');
      expect(t.tags).toContain('browser');
      expect(t.tags).toContain('network');
      expect(typeof t.execute).toBe('function');
      expect(typeof t.toJSON).toBe('function');
    });

    it('serializes to JSON schema', () => {
      const tools = createNetworkTools(session);
      const json = tools[0].toJSON();

      expect(json.name).toBe('browser_intercept_request');
      expect(json.parameters.type).toBe('object');
      expect(json.parameters.properties).toHaveProperty('urlPattern');
      expect(json.parameters.properties).toHaveProperty('action');
    });

    it('blocks matching requests', async () => {
      const tools = createNetworkTools(session);
      const t = tools[0];
      const result = await t.execute({ urlPattern: '**/ads/**', action: 'block' }, dummyContext);

      expect(result.interceptorId).toBe('interceptor_1');
      expect(mockPage.route).toHaveBeenCalledWith('**/ads/**', expect.any(Function));

      const handler = routes.get('**/ads/**')!;
      const mockRoute = { abort: vi.fn(), continue: vi.fn() };
      await handler(mockRoute);
      expect(mockRoute.abort).toHaveBeenCalled();
      expect(mockRoute.continue).not.toHaveBeenCalled();
    });

    it('modifies matching requests with headers, body, url', async () => {
      const tools = createNetworkTools(session);
      const t = tools[0];
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

      const handler = routes.get('**/api/**')!;
      const mockRoute = { abort: vi.fn(), continue: vi.fn() };
      await handler(mockRoute);
      expect(mockRoute.continue).toHaveBeenCalledWith({
        headers: { Authorization: 'Bearer token' },
        postData: '{"modified": true}',
        url: 'https://new-api.example.com/data',
      });
    });

    it('continues requests when action is continue', async () => {
      const tools = createNetworkTools(session);
      const t = tools[0];
      await t.execute({ urlPattern: '**/*', action: 'continue' }, dummyContext);

      const handler = routes.get('**/*')!;
      const mockRoute = { abort: vi.fn(), continue: vi.fn() };
      await handler(mockRoute);
      expect(mockRoute.continue).toHaveBeenCalledWith();
    });

    it('increments interceptor IDs', async () => {
      const tools = createNetworkTools(session);
      const t = tools[0];
      const r1 = await t.execute({ urlPattern: '/a', action: 'block' }, dummyContext);
      const r2 = await t.execute({ urlPattern: '/b', action: 'block' }, dummyContext);

      expect(r1.interceptorId).toBe('interceptor_1');
      expect(r2.interceptorId).toBe('interceptor_2');
    });
  });

  describe('createWaitForResponseTool', () => {
    it('has correct shape', () => {
      const t = createWaitForResponseTool(session);

      expect(t.name).toBe('browser_wait_for_response');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('browser');
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

      expect(mockPage.waitForResponse).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 5000,
      });
    });

    it('uses url predicate that checks includes', async () => {
      const t = createWaitForResponseTool(session);
      await t.execute({ urlPattern: 'api.example' }, dummyContext);

      const predicate = mockPage.waitForResponse.mock.calls[0][0];
      expect(predicate({ url: () => 'https://api.example.com/data' })).toBe(true);
      expect(predicate({ url: () => 'https://other.com/data' })).toBe(false);
    });

    it('returns empty body when text() throws', async () => {
      mockPage.waitForResponse.mockResolvedValueOnce({
        url: () => 'https://api.example.com/binary',
        status: () => 200,
        headers: () => ({}),
        text: () => Promise.reject(new Error('not text')),
      });

      const t = createWaitForResponseTool(session);
      const result = await t.execute({ urlPattern: 'api.example.com' }, dummyContext);

      expect(result.body).toBe('');
    });
  });

  describe('createBlockResourcesTool', () => {
    it('has correct shape', () => {
      const tools = createNetworkTools(session);
      const t = tools[2];

      expect(t.name).toBe('browser_block_resources');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('network');
    });

    it('sets up route for resource blocking', async () => {
      const tools = createNetworkTools(session);
      const t = tools[2];
      const result = await t.execute({ types: ['image', 'stylesheet'] }, dummyContext);

      expect(result.blocking).toBe(true);
      expect(result.types).toEqual(['image', 'stylesheet']);
      expect(result.interceptorId).toBeTruthy();
      expect(mockPage.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    });

    it('aborts blocked resource types', async () => {
      const tools = createNetworkTools(session);
      const t = tools[2];
      await t.execute({ types: ['image', 'font'] }, dummyContext);

      const handler = routes.get('**/*')!;

      const imageRoute = {
        request: () => ({ resourceType: () => 'image' }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      await handler(imageRoute);
      expect(imageRoute.abort).toHaveBeenCalled();

      const fontRoute = {
        request: () => ({ resourceType: () => 'font' }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      await handler(fontRoute);
      expect(fontRoute.abort).toHaveBeenCalled();
    });

    it('continues non-blocked resource types', async () => {
      const tools = createNetworkTools(session);
      const t = tools[2];
      await t.execute({ types: ['image'] }, dummyContext);

      const handler = routes.get('**/*')!;
      const docRoute = {
        request: () => ({ resourceType: () => 'document' }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      await handler(docRoute);
      expect(docRoute.continue).toHaveBeenCalled();
      expect(docRoute.abort).not.toHaveBeenCalled();
    });
  });

  describe('createCaptureHarTool', () => {
    it('has correct shape', () => {
      const t = createCaptureHarTool(session);

      expect(t.name).toBe('browser_capture_har');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('network');
    });

    it('starts capture and registers listener', async () => {
      const t = createCaptureHarTool(session);
      const result = await t.execute({ action: 'start' }, dummyContext);

      expect(result).toEqual({ capturing: true, entries: 0 });
      expect(mockPage.on).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('stops capture and returns entries', async () => {
      const t = createCaptureHarTool(session);
      await t.execute({ action: 'start' }, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/users',
          method: () => 'GET',
          headers: () => ({ accept: 'application/json' }),
          timing: () => ({ responseEnd: 150 }),
        }),
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('[]'),
      });

      const result = await t.execute({ action: 'stop' }, dummyContext);

      expect(result.capturing).toBe(false);
      expect(result.entries).toBe(1);
      expect(result.har).toHaveLength(1);
      expect(result.har[0]).toEqual({
        url: 'https://api.example.com/users',
        method: 'GET',
        status: 200,
        timing: 150,
        requestHeaders: { accept: 'application/json' },
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '[]',
      });
    });

    it('removes listener on stop', async () => {
      const t = createCaptureHarTool(session);
      await t.execute({ action: 'start' }, dummyContext);
      await t.execute({ action: 'stop' }, dummyContext);

      expect(mockPage.removeListener).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('clears entries after stop', async () => {
      const t = createCaptureHarTool(session);
      await t.execute({ action: 'start' }, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];
      await handler({
        request: () => ({
          url: () => 'https://example.com',
          method: () => 'GET',
          headers: () => ({}),
          timing: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
        text: () => Promise.resolve(''),
      });

      await t.execute({ action: 'stop' }, dummyContext);

      await t.execute({ action: 'start' }, dummyContext);
      const result2 = await t.execute({ action: 'stop' }, dummyContext);
      expect(result2.entries).toBe(0);
    });

    it('handles timing with no responseEnd', async () => {
      const t = createCaptureHarTool(session);
      await t.execute({ action: 'start' }, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];
      await handler({
        request: () => ({
          url: () => 'https://example.com',
          method: () => 'GET',
          headers: () => ({}),
          timing: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
        text: () => Promise.resolve(''),
      });

      const result = await t.execute({ action: 'stop' }, dummyContext);
      expect(result.har[0].timing).toBe(0);
    });
  });

  describe('createGetApiCallsTool', () => {
    it('has correct shape', () => {
      const tools = createNetworkTools(session);
      const t = tools[4];

      expect(t.name).toBe('browser_get_api_calls');
      expect(t.category).toBe('web');
      expect(t.tags).toContain('network');
    });

    it('starts listening and returns empty calls initially', async () => {
      const tools = createNetworkTools(session);
      const t = tools[4];
      const result = await t.execute({}, dummyContext);

      expect(result.calls).toEqual([]);
      expect(mockPage.on).toHaveBeenCalledWith('response', expect.any(Function));
    });

    it('captures xhr/fetch calls', async () => {
      const tools = createNetworkTools(session);
      const t = tools[4];

      await t.execute({}, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/users',
          method: () => 'GET',
          resourceType: () => 'xhr',
          headers: () => ({ accept: 'application/json' }),
        }),
        status: () => 200,
        headers: () => ({ 'content-type': 'application/json' }),
      });

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/posts',
          method: () => 'POST',
          resourceType: () => 'fetch',
          headers: () => ({}),
        }),
        status: () => 201,
        headers: () => ({}),
      });

      await handler({
        request: () => ({
          url: () => 'https://example.com/style.css',
          method: () => 'GET',
          resourceType: () => 'stylesheet',
          headers: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
      });

      const result = await t.execute({}, dummyContext);
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0].url).toBe('https://api.example.com/users');
      expect(result.calls[1].url).toBe('https://api.example.com/posts');
    });

    it('filters by urlPattern', async () => {
      const tools = createNetworkTools(session);
      const t = tools[4];
      await t.execute({}, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/users',
          method: () => 'GET',
          resourceType: () => 'xhr',
          headers: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
      });

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/posts',
          method: () => 'GET',
          resourceType: () => 'fetch',
          headers: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
      });

      const result = await t.execute({ urlPattern: '/users' }, dummyContext);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].url).toContain('/users');
    });

    it('filters by method', async () => {
      const tools = createNetworkTools(session);
      const t = tools[4];
      await t.execute({}, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/data',
          method: () => 'GET',
          resourceType: () => 'xhr',
          headers: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
      });

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/data',
          method: () => 'POST',
          resourceType: () => 'fetch',
          headers: () => ({}),
        }),
        status: () => 201,
        headers: () => ({}),
      });

      const result = await t.execute({ method: 'post' }, dummyContext);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].method).toBe('POST');
    });

    it('filters by both urlPattern and method', async () => {
      const tools = createNetworkTools(session);
      const t = tools[4];
      await t.execute({}, dummyContext);

      const responseHandlers = listeners.get('response') ?? [];
      const handler = responseHandlers[responseHandlers.length - 1];

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/users',
          method: () => 'GET',
          resourceType: () => 'xhr',
          headers: () => ({}),
        }),
        status: () => 200,
        headers: () => ({}),
      });

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/users',
          method: () => 'POST',
          resourceType: () => 'fetch',
          headers: () => ({}),
        }),
        status: () => 201,
        headers: () => ({}),
      });

      await handler({
        request: () => ({
          url: () => 'https://api.example.com/posts',
          method: () => 'POST',
          resourceType: () => 'fetch',
          headers: () => ({}),
        }),
        status: () => 201,
        headers: () => ({}),
      });

      const result = await t.execute({ urlPattern: '/users', method: 'POST' }, dummyContext);
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0].url).toContain('/users');
      expect(result.calls[0].method).toBe('POST');
    });
  });

  describe('createNetworkTools', () => {
    it('returns all 5 tools', () => {
      const tools = createNetworkTools(session);
      expect(tools).toHaveLength(5);
    });

    it('all tools have unique names', () => {
      const tools = createNetworkTools(session);
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(5);
    });

    it('tools are in expected order', () => {
      const tools = createNetworkTools(session);
      expect(tools[0].name).toBe('browser_intercept_request');
      expect(tools[1].name).toBe('browser_wait_for_response');
      expect(tools[2].name).toBe('browser_block_resources');
      expect(tools[3].name).toBe('browser_capture_har');
      expect(tools[4].name).toBe('browser_get_api_calls');
    });

    it('all tools have web category', () => {
      const tools = createNetworkTools(session);
      for (const t of tools) {
        expect(t.category).toBe('web');
      }
    });

    it('all tools have network tag', () => {
      const tools = createNetworkTools(session);
      for (const t of tools) {
        expect(t.tags).toContain('network');
      }
    });

    it('all tools serialize to JSON', () => {
      const tools = createNetworkTools(session);
      for (const t of tools) {
        const json = t.toJSON();
        expect(json.name).toBe(t.name);
        expect(json.parameters.type).toBe('object');
      }
    });
  });
});
