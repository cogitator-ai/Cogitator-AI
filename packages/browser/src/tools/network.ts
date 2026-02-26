import { tool } from '@cogitator-ai/core';
import type { BrowserSession } from '../session';
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

class NetworkState {
  private _interceptors = new Map<string, () => Promise<void>>();
  private _apiCalls: ApiCallRecord[] = [];
  private _listening = false;
  private _interceptorCounter = 0;

  get apiCalls() {
    return this._apiCalls;
  }

  async addInterceptor(_page: unknown, id: string, remover: () => Promise<void>) {
    this._interceptors.set(id, remover);
  }

  async removeInterceptor(id: string) {
    const remover = this._interceptors.get(id);
    if (remover) {
      await remover();
      this._interceptors.delete(id);
    }
  }

  startListening(page: BrowserSession['page']) {
    if (this._listening) return;
    this._listening = true;
    page.on(
      'response',
      async (response: {
        request: () => {
          url: () => string;
          method: () => string;
          resourceType: () => string;
          headers: () => Record<string, string>;
        };
        status: () => number;
        headers: () => Record<string, string>;
      }) => {
        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType === 'xhr' || resourceType === 'fetch') {
          this._apiCalls.push({
            url: request.url(),
            method: request.method(),
            status: response.status(),
            timing: 0,
            requestHeaders: request.headers(),
            responseHeaders: response.headers(),
          });
        }
      }
    );
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
      const id = state.nextId();

      const handler = async (route: {
        abort: () => Promise<void>;
        continue: (overrides?: Record<string, unknown>) => Promise<void>;
      }) => {
        if (params.action === 'block') {
          await route.abort();
        } else if (params.action === 'modify' && params.modify) {
          const overrides: Record<string, unknown> = {};
          if (params.modify.headers) overrides.headers = params.modify.headers;
          if (params.modify.body) overrides.postData = params.modify.body;
          if (params.modify.url) overrides.url = params.modify.url;
          await route.continue(overrides);
        } else {
          await route.continue();
        }
      };

      await page.route(params.urlPattern, handler);
      await state.addInterceptor(page, id, async () => {
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
        (resp: { url: () => string }) => resp.url().includes(params.urlPattern),
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
      const RESOURCE_MAP: Record<string, string> = {
        image: 'image',
        stylesheet: 'stylesheet',
        font: 'font',
        media: 'media',
        script: 'script',
      };

      const handler = async (route: {
        request: () => { resourceType: () => string };
        abort: () => Promise<void>;
        continue: () => Promise<void>;
      }) => {
        const resourceType = route.request().resourceType();
        if (
          types.has(resourceType) ||
          Array.from(types).some((t) => RESOURCE_MAP[t] === resourceType)
        ) {
          await route.abort();
        } else {
          await route.continue();
        }
      };

      const id = state.nextId();
      await page.route('**/*', handler);
      await state.addInterceptor(page, id, async () => {
        await page.unroute('**/*', handler);
      });

      return { blocking: true, interceptorId: id, types: params.types };
    },
  });
}

export function createCaptureHarTool(session: BrowserSession) {
  let harEntries: HarEntry[] = [];
  let harCapturing = false;
  let responseHandler: ((response: unknown) => void) | null = null;

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
        responseHandler = async (response: unknown) => {
          if (!harCapturing) return;
          const resp = response as {
            request: () => {
              url: () => string;
              method: () => string;
              headers: () => Record<string, string>;
              timing: () => { responseEnd?: number };
            };
            status: () => number;
            headers: () => Record<string, string>;
            text: () => Promise<string>;
          };
          const request = resp.request();
          let body = '';
          try {
            body = await resp.text();
          } catch {
            /* response body may not be available */
          }
          harEntries.push({
            url: request.url(),
            method: request.method(),
            status: resp.status(),
            timing: request.timing()?.responseEnd ?? 0,
            requestHeaders: request.headers(),
            responseHeaders: resp.headers(),
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
        await writeFile(params.path, JSON.stringify({ entries: harEntries }, null, 2));
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
