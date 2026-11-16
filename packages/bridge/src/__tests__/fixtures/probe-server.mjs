/**
 * An MCP server without dependencies that answers every tool call with what it knows of its
 * caller: its environment, its folder, the arguments and the `_meta` of the call. With
 * PROBE_WRITE set it also writes that file, to show where it may write.
 */
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'whoami',
    description: 'Says what the server knows of its caller.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
  {
    name: 'safe',
    description: 'The same, as a tool that destroys nothing and stays in a closed world.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '0.0.0' },
        instructions: `client ${params.clientInfo.name}`,
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    let wrote;
    if (process.env.PROBE_WRITE) {
      writeFileSync(process.env.PROBE_WRITE, 'written by the server');
      wrote = process.env.PROBE_WRITE;
    }
    const seen = {
      tool: params.name,
      args: params.arguments,
      meta: params._meta,
      cwd: process.cwd(),
      env: Object.keys(process.env).sort(),
      session: process.env.CLAUDE_CODE_SESSION_ID,
      mark: process.env.PROBE_MARK,
      wrote,
    };
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(seen) }] },
    });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
