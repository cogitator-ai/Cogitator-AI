/**
 * HTTP tool - make HTTP requests
 */

import { z } from 'zod';
import { tool } from '../tool.js';

const httpRequestParams = z.object({
  url: z.string().url().describe('The URL to request'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .optional()
    .describe('HTTP method (default: GET)'),
  headers: z
    .record(z.string())
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

export const httpRequest = tool({
  name: 'http_request',
  description:
    'Make an HTTP request. Supports all common HTTP methods, custom headers, and request body. Returns response status, headers, and body.',
  parameters: httpRequestParams,
  sideEffects: ['network'],
  execute: async ({ url, method = 'GET', headers = {}, body, timeout = 30000 }) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = response.headers.get('content-type') || '';
      let responseBody: string;

      if (contentType.includes('application/json')) {
        const json: unknown = await response.json();
        responseBody = JSON.stringify(json);
      } else {
        responseBody = await response.text();
      }

      // Truncate large responses
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
      clearTimeout(timeoutId);
      const error = err as Error;
      if (error.name === 'AbortError') {
        return { error: `Request timed out after ${timeout.toString()}ms`, url, method };
      }
      return { error: error.message, url, method };
    }
  },
});
