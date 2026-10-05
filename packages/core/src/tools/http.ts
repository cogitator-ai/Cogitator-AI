/**
 * HTTP tool - make HTTP requests
 */

import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';
import { createPublicFetch, type FetchFunction } from '../utils/public-network';

const httpRequestParams = z.object({
  url: z.string().url().describe('The URL to request'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .optional()
    .describe('HTTP method (default: GET)'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Request headers as key-value pairs'),
  body: z
    .string()
    .optional()
    .describe('Request body (for POST, PUT, PATCH). JSON should be stringified.'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .describe('Request timeout in milliseconds (default: 30000, max: 60000)'),
});

function normalizeJsonBody(body: string): string {
  if (!body.trim()) return body;
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
}

/** How an `http_request` tool reaches the network. */
export interface HttpRequestToolOptions {
  /**
   * Let the tool reach loopback, private and link-local hosts, for an agent that calls services
   * on a trusted network. Off by default: a model chooses the URL, and a page or a prompt can ask
   * it for `http://169.254.169.254/` or an internal admin API
   */
  allowPrivateNetwork?: boolean;
  /**
   * Sends requests instead of the built-in client, e.g. through a proxy. The tool then trusts it
   * with every URL, so it should apply its own network policy
   */
  fetch?: FetchFunction;
}

/** An `http_request` tool that reaches only public hosts unless told otherwise. */
export function createHttpRequestTool(options: HttpRequestToolOptions = {}) {
  const send =
    options.fetch ?? createPublicFetch({ allowPrivateNetwork: options.allowPrivateNetwork });

  return tool({
    name: 'http_request',
    description:
      'Make an HTTP request. Supports all common HTTP methods, custom headers, and request body. Returns response status, headers, and body.',
    parameters: httpRequestParams,
    sideEffects: ['network'],
    execute: async ({ url, method = 'GET', headers = {}, body, timeout = 30000 }, context) => {
      const abort = createLinkedAbortController(context?.signal, timeout);

      try {
        const response = await send(url, {
          method,
          headers,
          body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
          signal: abort.signal,
        });

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const contentType = response.headers.get('content-type') || '';
        const rawBody = await response.text();
        let responseBody = contentType.includes('application/json')
          ? normalizeJsonBody(rawBody)
          : rawBody;

        const maxBodySize = 100000;
        const truncated = responseBody.length > maxBodySize;
        if (truncated) {
          responseBody = responseBody.slice(0, maxBodySize);
        }

        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          truncated,
          url,
          method,
        };
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          return { error: getAbortErrorMessage('Request', abort, timeout), url, method };
        }
        return { error: error.message, url, method };
      } finally {
        abort.cleanup();
      }
    },
  });
}

/** The `http_request` tool, reaching public hosts only. */
export const httpRequest = createHttpRequestTool();
