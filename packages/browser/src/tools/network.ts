import { tool } from '@cogitator-ai/core';
import type { BrowserSession } from '../session';
import type { Page, Request, Response, Route } from 'playwright';
import {
  interceptRequestSchema,
  waitForResponseSchema,
  blockResourcesSchema,
  captureHarSchema,
  getApiCallsSchema,
  type InterceptRequestInput,
  type WaitForResponseInput,
  type BlockResourcesInput,
  type CaptureHarInput,
  type GetApiCallsInput,
} from '../utils/schemas';

interface ApiCallRecord {
  url: string;
  method: string;
  status: number;
  timing: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

interface HarEntry {
  url: string;
  method: string;
  status: number;
  timing: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

function networkTimingMs(request: Request): number {
  let timing: { startTime: number; responseEnd: number };
  try {
    timing = request.timing();
  } catch {
    return 0;
  }
  const start = timing.startTime;
  const end = timing.responseEnd;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0) return 0;
  return Math.max(0, end - start);
}

class NetworkState {
  private _interceptors = new Map<string, () => Promise<void>>();
  private _apiCalls: ApiCallRecord[] = [];
  private _listenedPage: Page | null = null;
  private _responseHandler: ((response: Response) => void) | null = null;
  private _interceptorCounter = 0;

  get apiCalls() {
    return this._apiCalls;
  }

  async addInterceptor(id: string, remover: () => Promise<void>) {
    this._interceptors.set(id, remover);
  }

  async removeInterceptor(id: string) {
    const remover = this._interceptors.get(id);
    if (remover) {
      await remover();
      this._interceptors.delete(id);
    }
  }

  startListening(page: Page) {
    if (this._listenedPage === page && this._responseHandler) return;
    if (this._listenedPage && this._responseHandler) {
      this._listenedPage.removeListener('response', this._responseHandler);
    }
    this._responseHandler = (response: Response) => {
      const request = response.request();
      const resourceType = request.resourceType();
      if (resourceType === 'xhr' || resourceType === 'fetch') {
        this._apiCalls.push({
          url: request.url(),
          method: request.method(),
          status: response.status(),
          timing: networkTimingMs(request),
          requestHeaders: request.headers(),
          responseHeaders: response.headers(),
        });
      }
    };
    page.on('response', this._responseHandler);
    this._listenedPage = page;
  }

  nextId() {
    return `interceptor_${++this._interceptorCounter}`;
  }

  clearApiCalls() {
    this._apiCalls = [];
  }
}

export function createInterceptRequestTool(session: BrowserSession, state: NetworkState) {
  return tool({
    name: 'browser_intercept_request',
    description: 'Intercept and modify, block, or continue HTTP requests matching a URL pattern.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: interceptRequestSchema,
    execute: async (params: InterceptRequestInput) => {
      const page = session.page;

      if (params.action === 'modify' && !params.modify) {
        return {
          interceptorId: null,
          warning:
            "action 'modify' requires a 'modify' object with headers, body, or url; no interceptor was registered",
        };
      }

      const id = state.nextId();

      const handler = async (route: Route) => {
        if (params.action === 'block') {
          await route.abort();
        } else if (params.action === 'modify' && params.modify) {
          const overrides: {
            headers?: Record<string, string>;
            postData?: string;
            url?: string;
          } = {};
          if (params.modify.headers) overrides.headers = params.modify.headers;
          if (params.modify.body) overrides.postData = params.modify.body;
          if (params.modify.url) overrides.url = params.modify.url;
          await route.continue(overrides);
        } else {
          await route.continue();
        }
      };

      await page.route(params.urlPattern, handler);
      await state.addInterceptor(id, async () => {
        await page.unroute(params.urlPattern, handler);
      });

      return { interceptorId: id };
    },
  });
}

export function createWaitForResponseTool(session: BrowserSession) {
  return tool({
    name: 'browser_wait_for_response',
    description:
      'Wait for an HTTP response matching a URL pattern. Returns status, headers, and body.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: waitForResponseSchema,
    execute: async (params: WaitForResponseInput) => {
      const page = session.page;
      const response = await page.waitForResponse(
        (resp: Response) => resp.url().includes(params.urlPattern),
        { timeout: params.timeout }
      );
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

export function createBlockResourcesTool(session: BrowserSession, state: NetworkState) {
  return tool({
    name: 'browser_block_resources',
    description:
      'Block specific resource types (images, stylesheets, fonts, media, scripts) from loading.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: blockResourcesSchema,
    execute: async (params: BlockResourcesInput) => {
      const page = session.page;
      const types = new Set<string>(params.types);

      const handler = async (route: Route) => {
        if (types.has(route.request().resourceType())) {
          await route.abort();
        } else {
          await route.continue();
        }
      };

      const id = state.nextId();
      await page.route('**/*', handler);
      await state.addInterceptor(id, async () => {
        await page.unroute('**/*', handler);
      });

      return { blocking: true, interceptorId: id, types: params.types };
    },
  });
}

export function createCaptureHarTool(session: BrowserSession) {
  let harEntries: HarEntry[] = [];
  let harCapturing = false;
  let responseHandler: ((response: Response) => void) | null = null;

  return tool({
    name: 'browser_capture_har',
    description:
      'Start or stop capturing HTTP traffic in HAR format. On stop, returns all captured entries.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: captureHarSchema,
    execute: async (params: CaptureHarInput) => {
      const page = session.page;

      if (params.action === 'start') {
        harEntries = [];
        harCapturing = true;
        responseHandler = async (response: Response) => {
          if (!harCapturing) return;
          const request = response.request();
          let body = '';
          try {
            body = await response.text();
          } catch {
            /* response body may not be available */
          }
          harEntries.push({
            url: request.url(),
            method: request.method(),
            status: response.status(),
            timing: networkTimingMs(request),
            requestHeaders: request.headers(),
            responseHeaders: response.headers(),
            responseBody: body,
          });
        };
        page.on('response', responseHandler);
        return { capturing: true, entries: 0 };
      }

      harCapturing = false;
      if (responseHandler) {
        page.removeListener('response', responseHandler);
        responseHandler = null;
      }
      if (params.path) {
        const { writeFile } = await import('node:fs/promises');
        const path = await import('node:path');
        const basePath = process.cwd();
        const target = path.resolve(basePath, path.normalize(params.path));
        if (target !== basePath && !target.startsWith(basePath + path.sep)) {
          throw new Error(`HAR output path must be within the working directory: ${params.path}`);
        }
        await writeFile(target, JSON.stringify({ entries: harEntries }, null, 2));
      }
      const entries = [...harEntries];
      harEntries = [];
      return { capturing: false, entries: entries.length, har: entries };
    },
  });
}

export function createGetApiCallsTool(session: BrowserSession, state: NetworkState) {
  return tool({
    name: 'browser_get_api_calls',
    description:
      'Get captured XHR/fetch API calls, optionally filtered by URL pattern or HTTP method.',
    category: 'web' as const,
    tags: ['browser', 'network'],
    parameters: getApiCallsSchema,
    execute: async (params: GetApiCallsInput) => {
      state.startListening(session.page);
      let calls = state.apiCalls;
      if (params.urlPattern) {
        calls = calls.filter((c) => c.url.includes(params.urlPattern!));
      }
      if (params.method) {
        const method = params.method.toUpperCase();
        calls = calls.filter((c) => c.method === method);
      }
      return { calls };
    },
  });
}

export function createNetworkTools(session: BrowserSession) {
  const state = new NetworkState();
  return [
    createInterceptRequestTool(session, state),
    createWaitForResponseTool(session),
    createBlockResourcesTool(session, state),
    createCaptureHarTool(session),
    createGetApiCallsTool(session, state),
  ];
}
