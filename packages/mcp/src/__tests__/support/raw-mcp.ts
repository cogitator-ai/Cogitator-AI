/**
 * JSON-RPC requests of protocol 2026-07-28 sent by hand over HTTP, to see the wire as it is
 */

let nextId = 0;

export interface RawOptions {
  capabilities?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** `params` fields besides `_meta` */
  params?: Record<string, unknown>;
}

export interface RawReply {
  status: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const NAME_SOURCE: Record<string, string> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
  'tasks/get': 'taskId',
  'tasks/update': 'taskId',
  'tasks/cancel': 'taskId',
};

/** Sends `method` to the MCP endpoint `url` as a client of 2026-07-28 would */
export async function rawRequest(
  url: string,
  method: string,
  options: RawOptions = {}
): Promise<RawReply> {
  const params = {
    ...options.params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': options.capabilities ?? {},
    },
  };
  const source = NAME_SOURCE[method];
  const name: unknown = source ? options.params?.[source] : undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
    ...options.headers,
  };
  if (typeof name === 'string') headers['Mcp-Name'] = name;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  const text = await response.text();
  const json = parseBody(text, response.headers.get('content-type') ?? '');
  return {
    status: response.status,
    ...(json?.result !== undefined && { result: json.result as Record<string, unknown> }),
    ...(json?.error !== undefined && { error: json.error as RawReply['error'] & object }),
  };
}

function parseBody(text: string, contentType: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return undefined;
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
      .filter((message) => 'result' in message || 'error' in message);
    return data.at(-1);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export const ELICITATION = { elicitation: { form: {} } };
export const TASKS = { extensions: { 'io.modelcontextprotocol/tasks': {} } };
