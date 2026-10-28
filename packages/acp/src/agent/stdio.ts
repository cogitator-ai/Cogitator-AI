import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import type { AcpAgent } from './acp-agent.js';

export interface ServeAcpStdioOptions {
  /** What the editor writes: `process.stdin` by default */
  input?: Readable;
  /** Where the agent writes: `process.stdout` by default. Nothing else may write to it */
  output?: Writable;
}

/**
 * An ACP stream over Node streams, NDJSON both ways: what `output` is written to and what is read
 * from `input`, such as the stdin and stdout of an agent process a client spawned
 */
export function nodeNdJsonStream(output: Writable, input: Readable): Stream {
  return ndJsonStream(
    Writable.toWeb(output) as WritableStream<Uint8Array>,
    Readable.toWeb(input) as ReadableStream<Uint8Array>
  );
}

/**
 * Serves `agent` to the editor that launched the process over stdio, JSON-RPC as NDJSON, and
 * resolves once the editor closed its end: then every session is closed, their turns
 * interrupted, their workspaces and MCP servers released
 */
export async function serveAcpStdio(
  agent: AcpAgent,
  options: ServeAcpStdioOptions = {}
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const connection = agent.app.connect(nodeNdJsonStream(output, input));
  try {
    await connection.closed;
  } finally {
    await agent.close();
  }
}
