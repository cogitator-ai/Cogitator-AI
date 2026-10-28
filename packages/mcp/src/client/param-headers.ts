/**
 * `Mcp-Param-{Name}` headers of a `tools/call` over Streamable HTTP (protocol 2026-07-28): the
 * arguments a tool's `inputSchema` marks with `x-mcp-header`, mirrored into headers so gateways
 * can route on them
 */

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SAFE_VALUE = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/;
const SENTINEL = /^=\?base64\?.*\?=$/s;

/** The `Mcp-Param-*` headers for `args` of a tool with `inputSchema` */
export function mcpParamHeaders(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { name, path } of headerParams(inputSchema)) {
    const value = valueAt(args, path);
    if (value === undefined || value === null) continue;
    const text = headerText(value);
    if (text !== undefined) headers[`Mcp-Param-${name}`] = encodeHeaderValue(text);
  }
  return headers;
}

/** A header value as MCP carries it: plain when it is safe ASCII, else `=?base64?…?=` */
export function encodeHeaderValue(value: string): string {
  if (SAFE_VALUE.test(value) && !SENTINEL.test(value)) return value;
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

interface HeaderParam {
  name: string;
  path: string[];
}

function headerParams(schema: Record<string, unknown>, path: string[] = []): HeaderParam[] {
  const properties = schema.properties;
  if (!isRecord(properties)) return [];
  const params: HeaderParam[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue;
    const name = property['x-mcp-header'];
    if (typeof name === 'string' && HEADER_NAME.test(name)) {
      params.push({ name, path: [...path, key] });
    }
    params.push(...headerParams(property, [...path, key]));
  }
  return params;
}

function valueAt(args: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = args;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function headerText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
