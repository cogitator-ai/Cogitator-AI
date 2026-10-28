import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAppServer } from '../server/app-server';
import { OrderedLineWriter, serveStdio, type StdioOutput } from '../server/stdio';
import { answer, createTestHost, scriptedBackend, waitUntil } from './helpers';

function stdio() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  let buffered = '';
  output.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      messages.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  });
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  return { input, output, messages, send };
}

const initialize = {
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientInfo: { name: 'stdio-test' } },
};

describe('serveStdio', () => {
  it('serves NDJSON, lenient about jsonrpc, and answers a broken line with a parse error', async () => {
    const { host } = createTestHost({ backend: scriptedBackend([answer('hi there')]).backend });
    const io = stdio();
    const served = serveStdio(createAppServer(host), { input: io.input, output: io.output });
    io.send(initialize);
    io.input.write('{not json\n');
    io.send({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: { threadId: 'stdio-1' } });
    await waitUntil(() => io.messages.some((m) => m.id === 2));
    io.send({
      id: 3,
      method: 'turn/start',
      params: { threadId: 'stdio-1', input: [{ type: 'text', text: 'hello' }] },
    });
    await waitUntil(() => io.messages.some((m) => m.method === 'turn/completed'));
    io.input.end();
    await served;

    expect(io.messages.find((m) => m.id === 1)).toMatchObject({
      jsonrpc: '2.0',
      result: { protocolVersion: 1 },
    });
    expect(io.messages).toContainEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: expect.stringContaining('Line 2') },
    });
    const answerAt = io.messages.findIndex((m) => m.id === 3);
    const startedAt = io.messages.findIndex((m) => m.method === 'turn/started');
    expect(answerAt).toBeLessThan(startedAt);
    const done = io.messages.find((m) => m.method === 'turn/completed');
    expect(done).toMatchObject({ params: { turn: { status: 'completed', output: 'hi there' } } });
    await host.close();
  });

  it('interrupts the turns going on when the input ends, then resolves', async () => {
    const scripted = scriptedBackend([{ hold: true, first: 'thinking' }]);
    const { host } = createTestHost({ backend: scripted.backend });
    const io = stdio();
    const served = serveStdio(createAppServer(host), { input: io.input, output: io.output });
    io.send(initialize);
    io.send({ id: 2, method: 'thread/start', params: { threadId: 'eof' } });
    await waitUntil(() => io.messages.some((m) => m.id === 2));
    io.send({
      id: 3,
      method: 'turn/start',
      params: { threadId: 'eof', input: [{ type: 'text', text: 'long job' }] },
    });
    await waitUntil(() => scripted.requests.length === 1);
    io.input.end();
    await served;
    const done = io.messages.find((m) => m.method === 'turn/completed');
    expect(done).toMatchObject({ params: { turn: { status: 'interrupted' } } });
    await host.close();
  });
});

class SlowOutput extends EventEmitter implements StdioOutput {
  readonly written: string[] = [];
  private blocked = 0;

  write(chunk: string): boolean {
    this.written.push(chunk);
    this.blocked++;
    setTimeout(() => {
      this.blocked--;
      this.emit('drain');
    }, 2);
    return false;
  }

  get pending(): number {
    return this.blocked;
  }
}

describe('OrderedLineWriter', () => {
  it('writes in order and waits for drain before the next line', async () => {
    const output = new SlowOutput();
    const writer = new OrderedLineWriter(output);
    const maxPending: number[] = [];
    const writes = ['a\n', 'b\n', 'c\n', 'd\n'].map((line) =>
      writer.write(line).then(() => maxPending.push(output.pending))
    );
    await Promise.all(writes);
    await writer.drained();
    expect(output.written).toEqual(['a\n', 'b\n', 'c\n', 'd\n']);
    expect(Math.max(...maxPending)).toBeLessThanOrEqual(1);
  });

  it('fails the lines after a write error', async () => {
    const output = new EventEmitter() as EventEmitter & StdioOutput;
    output.write = () => {
      queueMicrotask(() => output.emit('error', new Error('EPIPE')));
      return false;
    };
    const writer = new OrderedLineWriter(output);
    await expect(writer.write('x\n')).rejects.toThrow('EPIPE');
    await expect(writer.write('y\n')).rejects.toThrow('EPIPE');
  });
});
