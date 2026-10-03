import { createRequire } from 'node:module';
import { tool, toolset } from '@cogitator-ai/core';
import type { HarEntry } from '@cogitator-ai/types';
import type { BrowserContext, Request, Response, Route } from 'playwright';
import type { BrowserSession } from '../session';
import {
  interceptRequestSchema,
  removeInterceptorSchema,
  waitForResponseSchema,
  blockResourcesSchema,
  captureHarSchema,
  getApiCallsSchema,
  type InterceptRequestInput,
  type RemoveInterceptorInput,
  type WaitForResponseInput,
  type BlockResourcesInput,
  type CaptureHarInput,
  type GetApiCallsInput,
} from '../utils/schemas';

const MAX_API_CALLS = 1000;
const MAX_HAR_ENTRIES = 5000;
const HAR_SETTLE_TIMEOUT_MS = 2000;
const MAX_HAR_BODY_BYTES = 1_000_000;
const REGEX_LITERAL = /^\/(.+)\/([dgimsuvy]*)$/;
const TEXTUAL_MIME =
  /^(text\/|application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql)|application\/[\w.+-]+\+(json|xml)|image\/svg\+xml)/i;

interface ApiCallRecord {
  url: string;
  method: string;
  status: number;
  timing: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  error?: string;
}

interface CapturedExchange extends HarEntry {
  startedDateTime: string;
  statusText: string;
  mimeType: string;
  bodySize: number;
  error?: string;
}

interface HarCapture {
  entries: Array<CapturedExchange | null>;
  inflight: Set<Promise<void>>;
  truncated: boolean;
}

interface HarSlot {
  har: HarCapture;
  index: number;
  settle: () => void;
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function toUrlMatcher(pattern: string): string | RegExp {
  const literal = REGEX_LITERAL.exec(pattern);
  if (!literal) return pattern;
  try {
    return new RegExp(literal[1], literal[2].replace(/[gy]/g, ''));
  } catch {
    throw new Error(`Invalid regular expression in urlPattern: ${pattern}`);
  }
}

function createUrlPredicate(pattern: string): (url: string) => boolean {
  const matcher = toUrlMatcher(pattern);
  return typeof matcher === 'string' ? (url) => url.includes(matcher) : (url) => matcher.test(url);
}

function networkTimingMs(request: Request): number {
  let timing: { startTime: number; responseEnd: number };
  try {
    timing = request.timing();
  } catch {
    return 0;
  }
  const end = timing.responseEnd;
  if (!Number.isFinite(end) || end < 0) return 0;
  return end;
}

function startedDateTime(request: Request): string {
  try {
    const { startTime } = request.timing();
    if (Number.isFinite(startTime) && startTime > 0) {
      return new Date(startTime).toISOString();
    }
  } catch {}
  return new Date().toISOString();
}

function isApiRequest(request: Request): boolean {
  const type = request.resourceType();
  return type === 'xhr' || type === 'fetch';
}

async function readTextBody(
  response: Response,
  mimeType: string
): Promise<{ text?: string; size: number }> {
  try {
    const body = await response.body();
    if (!TEXTUAL_MIME.test(mimeType) || body.byteLength > MAX_HAR_BODY_BYTES) {
      return { size: body.byteLength };
    }
    return { text: body.toString('utf-8'), size: body.byteLength };
  } catch {
    return { size: -1 };
  }
}

function toNameValue(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryStringOf(url: string): Array<{ name: string; value: string }> {
  try {
    return Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function toHarLog(entries: CapturedExchange[]) {
  return {
    log: {
      version: '1.2',
      creator: { name: '@cogitator-ai/browser', version: packageVersion() },
      pages: [],
      entries: entries.map((entry) => ({
        startedDateTime: entry.startedDateTime,
        time: entry.timing,
        request: {
          method: entry.method,
          url: entry.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: toNameValue(entry.requestHeaders),
          queryString: queryStringOf(entry.url),
          headersSize: -1,
          bodySize: entry.requestBody ? Buffer.byteLength(entry.requestBody) : 0,
          ...(entry.requestBody !== undefined
            ? {
                postData: {
                  mimeType: entry.requestHeaders['content-type'] ?? '',
                  text: entry.requestBody,
                },
              }
            : {}),
        },
        response: {
          status: entry.status,
          statusText: entry.statusText,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: toNameValue(entry.responseHeaders),
          content: {
            size: entry.bodySize,
            mimeType: entry.mimeType,
            ...(entry.responseBody !== undefined ? { text: entry.responseBody } : {}),
          },
          redirectURL: entry.responseHeaders.location ?? '',
          headersSize: -1,
          bodySize: entry.bodySize,
          ...(entry.error ? { _error: entry.error } : {}),
        },
        cache: {},
        timings: { send: 0, wait: entry.timing, receive: 0 },
      })),
    },
  };
}

function toPublicHarEntry(entry: CapturedExchange): HarEntry {
  const result: HarEntry = {
    url: entry.url,
    method: entry.method,
    status: entry.status,
    timing: entry.timing,
    requestHeaders: entry.requestHeaders,
    responseHeaders: entry.responseHeaders,
  };
  if (entry.requestBody !== undefined) result.requestBody = entry.requestBody;
  if (entry.responseBody !== undefined) result.responseBody = entry.responseBody;
  return result;
}

class NetworkState {
  private _interceptors = new Map<string, () => Promise<void>>();
  private _apiCalls: ApiCallRecord[] = [];
  private _interceptorCounter = 0;
  private _context: BrowserContext | null = null;
  private _har: HarCapture | null = null;
  private _harSlots = new WeakMap<Request, HarSlot>();

  constructor(private readonly _session: BrowserSession) {
    _session.onStart((context) => this._attach(context));
  }

  get apiCalls(): ApiCallRecord[] {
    return this._apiCalls;
  }

  get harCapturing(): boolean {
    return this._har !== null;
  }

  removeApiCalls(calls: readonly ApiCallRecord[]): void {
    const removed = new Set(calls);
    this._apiCalls = this._apiCalls.filter((call) => !removed.has(call));
  }

  async addRoute(
    pattern: string | RegExp,
    handler: (route: Route) => Promise<void>
  ): Promise<string> {
    const context = this._requireContext();
    await context.route(pattern, handler);
    const id = `interceptor_${++this._interceptorCounter}`;
    this._interceptors.set(id, async () => {
      await context.unroute(pattern, handler);
    });
    return id;
  }

  async removeInterceptor(id: string): Promise<boolean> {
    const remover = this._interceptors.get(id);
    if (!remover) return false;
    this._interceptors.delete(id);
    await remover();
    return true;
  }

  async removeAllInterceptors(): Promise<string[]> {
    const ids = [...this._interceptors.keys()];
    for (const id of ids) {
      await this.removeInterceptor(id);
    }
    return ids;
  }

  startHar(): void {
    this._requireContext();
    this._har = { entries: [], inflight: new Set(), truncated: false };
  }

  async stopHar(): Promise<{ entries: CapturedExchange[]; truncated: boolean } | null> {
    const har = this._har;
    this._har = null;
    if (!har) return null;
    if (har.inflight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...har.inflight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, HAR_SETTLE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return {
      entries: har.entries.filter((entry): entry is CapturedExchange => entry !== null),
      truncated: har.truncated,
    };
  }

  private _requireContext(): BrowserContext {
    const context = this._session.context;
    if (!context) {
      throw new Error('BrowserSession not started');
    }
    if (context !== this._context) {
      this._attach(context);
    }
    return context;
  }

  private _attach(context: BrowserContext): void {
    if (this._context === context) return;
    this._context = context;
    this._interceptors.clear();
    this._har = null;

    context.on('request', (request) => {
      if (this._context !== context) return;
      this._reserveHarSlot(request);
    });
    context.on('requestfinished', (request) => {
      if (this._context !== context) return;
      this._observe(request, null);
    });
    context.on('requestfailed', (request) => {
      if (this._context !== context) return;
      this._observe(request, request.failure()?.errorText ?? 'Request failed');
    });
  }

  private _reserveHarSlot(request: Request): void {
    const har = this._har;
    if (!har) return;
    if (har.entries.length >= MAX_HAR_ENTRIES) {
      har.truncated = true;
      return;
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = () => {
        har.inflight.delete(settled);
        resolve();
      };
    });
    har.inflight.add(settled);
    this._harSlots.set(request, { har, index: har.entries.push(null) - 1, settle });
  }

  private _observe(request: Request, error: string | null): void {
    const slot = this._harSlots.get(request) ?? null;
    this._harSlots.delete(request);
    if (!slot && !isApiRequest(request)) return;
    const work = this._record(request, error, slot);
    if (slot) {
      void work.finally(slot.settle);
    }
  }

  private async _record(
    request: Request,
    error: string | null,
    slot: HarSlot | null
  ): Promise<void> {
    try {
      const response = error ? null : await request.response();
      const responseHeaders = response?.headers() ?? {};
      const status = response?.status() ?? 0;
      const timing = networkTimingMs(request);

      if (isApiRequest(request)) {
        this._apiCalls.push({
          url: request.url(),
          method: request.method(),
          status,
          timing,
          requestHeaders: request.headers(),
          responseHeaders,
          ...(error ? { error } : {}),
        });
        if (this._apiCalls.length > MAX_API_CALLS) {
          this._apiCalls.splice(0, this._apiCalls.length - MAX_API_CALLS);
        }
      }

      if (!slot) return;

      const mimeType = responseHeaders['content-type'] ?? '';
      const body = response ? await readTextBody(response, mimeType) : { size: 0 };
      const entry: CapturedExchange = {
        url: request.url(),
        method: request.method(),
        status,
        statusText: response?.statusText() ?? '',
        timing,
        startedDateTime: startedDateTime(request),
        requestHeaders: request.headers(),
        responseHeaders,
        mimeType,
        bodySize: body.size,
      };
      const postData = request.postData();
      if (postData !== null) entry.requestBody = postData;
      if (body.text !== undefined) entry.responseBody = body.text;
      if (error) entry.error = error;
      slot.har.entries[slot.index] = entry;
    } catch {}
  }
}

const networkStates = new WeakMap<BrowserSession, NetworkState>();

function networkStateFor(session: BrowserSession): NetworkState {
  let state = networkStates.get(session);
  if (!state) {
    state = new NetworkState(session);
    networkStates.set(session, state);
  }
  return state;
}

export function createInterceptRequestTool(session: BrowserSession) {
  const state = networkStateFor(session);
  return tool({
    name: 'browser_intercept_request',
    description:
      'Intercept and modify, block, or continue HTTP requests matching a URL pattern in all tabs. Returns an interceptorId that can be passed to browser_remove_interceptor.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: interceptRequestSchema,
    execute: async (params: InterceptRequestInput) => {
      if (params.action === 'modify' && !params.modify) {
        return {
          interceptorId: null,
          warning:
            "action 'modify' requires a 'modify' object with headers, body, or url; no interceptor was registered",
        };
      }

      const handler = async (route: Route) => {
        if (params.action === 'block') {
          await route.abort();
          return;
        }
        if (params.action === 'modify' && params.modify) {
          const overrides: {
            headers?: Record<string, string>;
            postData?: string;
            url?: string;
          } = {};
          if (params.modify.headers) {
            overrides.headers = { ...route.request().headers(), ...params.modify.headers };
          }
          if (params.modify.body !== undefined) overrides.postData = params.modify.body;
          if (params.modify.url !== undefined) overrides.url = params.modify.url;
          await route.fallback(overrides);
          return;
        }
        await route.fallback();
      };

      const interceptorId = await state.addRoute(toUrlMatcher(params.urlPattern), handler);
      return { interceptorId };
    },
  });
}

export function createRemoveInterceptorTool(session: BrowserSession) {
  const state = networkStateFor(session);
  return tool({
    name: 'browser_remove_interceptor',
    description:
      'Remove a request interceptor created by browser_intercept_request or browser_block_resources. Omit interceptorId to remove all interceptors.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: removeInterceptorSchema,
    execute: async (params: RemoveInterceptorInput) => {
      if (params.interceptorId === undefined) {
        return { removed: await state.removeAllInterceptors() };
      }
      const removed = await state.removeInterceptor(params.interceptorId);
      return { removed: removed ? [params.interceptorId] : [] };
    },
  });
}

export function createWaitForResponseTool(session: BrowserSession) {
  return tool({
    name: 'browser_wait_for_response',
    description:
      'Wait for an HTTP response whose URL contains the given substring (or matches /regex/flags). Returns status, headers, and body.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: waitForResponseSchema,
    execute: async (params: WaitForResponseInput) => {
      const page = session.page;
      const matches = createUrlPredicate(params.urlPattern);
      const response = await page.waitForResponse((resp: Response) => matches(resp.url()), {
        timeout: params.timeout,
      });
      let body: string;
      try {
        body = await response.text();
      } catch {
        body = '';
      }
      return {
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        body,
      };
    },
  });
}

export function createBlockResourcesTool(session: BrowserSession) {
  const state = networkStateFor(session);
  return tool({
    name: 'browser_block_resources',
    description:
      'Block specific resource types (images, stylesheets, fonts, media, scripts) from loading in all tabs.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: blockResourcesSchema,
    execute: async (params: BlockResourcesInput) => {
      const types = new Set<string>(params.types);

      const handler = async (route: Route) => {
        if (types.has(route.request().resourceType())) {
          await route.abort();
        } else {
          await route.fallback();
        }
      };

      const interceptorId = await state.addRoute('**/*', handler);
      return { blocking: true, interceptorId, types: params.types };
    },
  });
}

export function createCaptureHarTool(session: BrowserSession) {
  const state = networkStateFor(session);
  return tool({
    name: 'browser_capture_har',
    description:
      'Start or stop capturing HTTP traffic of all tabs. On stop, returns the captured entries and optionally writes a HAR 1.2 file.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: captureHarSchema,
    execute: async (params: CaptureHarInput) => {
      if (params.action === 'start') {
        state.startHar();
        return { capturing: true, entries: 0 };
      }

      const har = await state.stopHar();
      const entries = har?.entries ?? [];

      let savedPath: string | undefined;
      if (params.path) {
        const { writeFile } = await import('node:fs/promises');
        const path = await import('node:path');
        const basePath = process.cwd();
        const target = path.resolve(basePath, path.normalize(params.path));
        if (target !== basePath && !target.startsWith(basePath + path.sep)) {
          throw new Error(`HAR output path must be within the working directory: ${params.path}`);
        }
        await writeFile(target, JSON.stringify(toHarLog(entries), null, 2));
        savedPath = target;
      }

      return {
        capturing: false,
        entries: entries.length,
        truncated: har?.truncated ?? false,
        har: entries.map(toPublicHarEntry),
        ...(savedPath ? { path: savedPath } : {}),
      };
    },
  });
}

export function createGetApiCallsTool(session: BrowserSession) {
  const state = networkStateFor(session);
  return tool({
    name: 'browser_get_api_calls',
    description:
      'Get XHR/fetch API calls captured since the session started, optionally filtered by URL substring (or /regex/flags) and HTTP method.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: getApiCallsSchema,
    execute: async (params: GetApiCallsInput) => {
      let calls = state.apiCalls;
      if (params.urlPattern) {
        const matches = createUrlPredicate(params.urlPattern);
        calls = calls.filter((c) => matches(c.url));
      }
      if (params.method) {
        const method = params.method.toUpperCase();
        calls = calls.filter((c) => c.method === method);
      }
      const result = { calls: [...calls] };
      if (params.clear) state.removeApiCalls(result.calls);
      return result;
    },
  });
}

export function createNetworkTools(session: BrowserSession) {
  return toolset(
    createInterceptRequestTool(session),
    createWaitForResponseTool(session),
    createBlockResourcesTool(session),
    createCaptureHarTool(session),
    createGetApiCallsTool(session),
    createRemoveInterceptorTool(session)
  );
}
