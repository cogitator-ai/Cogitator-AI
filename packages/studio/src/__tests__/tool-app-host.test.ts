import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ToolAppCallOutcome } from '../protocol.js';
import {
  createConfirmQueue,
  createToolAppHost,
  recordResult,
  toolCallResult,
  type PendingAppCall,
} from '../ui/tool-app-host.js';

interface Seen {
  input?: Record<string, unknown>;
  result?: CallToolResult;
  cancelled?: string;
}

/** An app on the other side of the bridge, as an MCP App page runs it, and what it heard */
async function connect(options: Parameters<typeof createToolAppHost>[0]) {
  const host = createToolAppHost(options);
  const [hostSide, appSide] = InMemoryTransport.createLinkedPair();
  const seen: Seen = {};
  const app = new App({ name: 'cart', version: '1.0.0' }, {}, { autoResize: false });
  app.ontoolinput = ({ arguments: args }) => {
    seen.input = args;
  };
  app.ontoolresult = (result) => {
    seen.result = result;
  };
  app.ontoolcancelled = ({ reason }) => {
    seen.cancelled = reason;
  };
  await host.bridge.connect(hostSide);
  await app.connect(appSide);
  return { host, app, seen };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function done(text: string): ToolAppCallOutcome {
  return { status: 'done', result: { content: [{ type: 'text', text }] } };
}

describe('createToolAppHost', () => {
  it('tells the app the call once it initialized: arguments, then the result', async () => {
    const { host, seen } = await connect({
      callTool: async () => done('unused'),
      confirm: async () => true,
    });
    host.show({ arguments: { year: 2025 } });
    await settle();
    expect(seen.input).toEqual({ year: 2025 });
    expect(seen.result).toBeUndefined();

    host.show({ arguments: { year: 2025 }, result: { total: 42 } });
    host.show({ arguments: { year: 2025 }, result: { total: 42 } });
    await settle();
    expect(seen.result).toEqual({
      content: [{ type: 'text', text: '{"total":42}' }],
      structuredContent: { total: 42 },
    });
    await host.close();
  });

  it('cancels the call for the app when it failed', async () => {
    const { host, seen } = await connect({
      callTool: async () => done('unused'),
      confirm: async () => true,
    });
    host.show({ arguments: {}, error: 'The tool timed out' });
    await settle();
    expect(seen.cancelled).toBe('The tool timed out');
    expect(seen.result).toBeUndefined();
    await host.close();
  });

  it('runs the tool calls of the app, asking the person first when the server wants it', async () => {
    const asked: string[] = [];
    const runs: Array<{ name: string; approved: boolean }> = [];
    const { host, app } = await connect({
      callTool: async (name, _args, approved) => {
        runs.push({ name, approved });
        return name === 'empty_cart' && !approved
          ? { status: 'approval', tool: name }
          : done(`${name} ran`);
      },
      confirm: async (name) => {
        asked.push(name);
        return name === 'empty_cart';
      },
    });

    await expect(app.callServerTool({ name: 'refresh', arguments: {} })).resolves.toEqual({
      content: [{ type: 'text', text: 'refresh ran' }],
    });
    await expect(
      app.callServerTool({ name: 'empty_cart', arguments: { all: true } })
    ).resolves.toEqual({ content: [{ type: 'text', text: 'empty_cart ran' }] });
    expect(asked).toEqual(['empty_cart']);
    expect(runs).toEqual([
      { name: 'refresh', approved: false },
      { name: 'empty_cart', approved: false },
      { name: 'empty_cart', approved: true },
    ]);
    await host.close();
  });

  it('answers a declined or failed call with an error result the app can read', async () => {
    const { host, app } = await connect({
      callTool: async (name) => {
        if (name === 'broken') throw new Error('The MCP tool "broken" is not open to apps');
        return { status: 'approval', tool: name };
      },
      confirm: async () => false,
    });
    await expect(app.callServerTool({ name: 'wipe', arguments: {} })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The user declined the call of wipe' }],
    });
    await expect(app.callServerTool({ name: 'broken', arguments: {} })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'The MCP tool "broken" is not open to apps' }],
    });
    await host.close();
  });

  it('sizes the frame and opens web links only', async () => {
    const sizes: Array<number | undefined> = [];
    const links: string[] = [];
    const { host, app } = await connect({
      callTool: async () => done('unused'),
      confirm: async () => true,
      onSize: ({ height }) => sizes.push(height),
      openLink: (url) => links.push(url),
    });
    await app.sendSizeChanged({ height: 320 });
    await expect(app.openLink({ url: 'https://example.com/docs' })).resolves.toEqual({});
    await expect(app.openLink({ url: 'javascript:alert(1)' })).resolves.toMatchObject({
      isError: true,
    });
    await settle();
    expect(sizes).toEqual([320]);
    expect(links).toEqual(['https://example.com/docs']);
    await host.close();
  });
});

describe('results for apps', () => {
  it('turns a run result into a tool result', () => {
    expect(recordResult({ result: 'plain text' })).toEqual({
      content: [{ type: 'text', text: 'plain text' }],
    });
    expect(recordResult({ result: [1, 2] })).toEqual({
      content: [{ type: 'text', text: '[1,2]' }],
      structuredContent: { result: [1, 2] },
    });
    expect(recordResult({ result: null })).toEqual({ content: [] });
    expect(recordResult({ error: 'boom' })).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });

  it('turns a result with media back into the content blocks the server sent', () => {
    const envelope = {
      type: 'tool-content',
      content: [
        { type: 'text', text: 'The chart' },
        { type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
        { type: 'file', data: 'SUQz', mediaType: 'audio/mpeg' },
        { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf', filename: 'file:///r.pdf' },
        { type: 'resource', uri: 'file:///notes.md', mediaType: 'text/markdown', text: '# Notes' },
        { type: 'resource', uri: 'https://example.com/report', name: 'Report' },
        { type: 'json', value: { rows: 2 } },
      ],
    };
    const result = recordResult({ result: envelope });
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'The chart' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'audio', data: 'SUQz', mimeType: 'audio/mpeg' },
        {
          type: 'resource',
          resource: { uri: 'file:///r.pdf', mimeType: 'application/pdf', blob: 'JVBERi0=' },
        },
        {
          type: 'resource',
          resource: { uri: 'file:///notes.md', mimeType: 'text/markdown', text: '# Notes' },
        },
        { type: 'resource_link', uri: 'https://example.com/report', name: 'Report' },
        { type: 'text', text: '{"rows":2}' },
      ],
    });
    expect(toolCallResult({ content: result.content })).toEqual(result);
  });

  it('sends a result with media to the app as its blocks', async () => {
    const { host, seen } = await connect({
      callTool: async () => done('unused'),
      confirm: async () => true,
    });
    host.show({
      arguments: {},
      result: {
        type: 'tool-content',
        content: [{ type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
      },
    });
    await settle();
    expect(seen.result).toEqual({
      content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    });
    await host.close();
  });

  it('passes a server result through and refuses what is none', () => {
    const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
    expect(toolCallResult(result)).toEqual(result);
    expect(toolCallResult({ content: [{ type: 'nonsense' }] }).isError).toBe(true);
  });
});

describe('createConfirmQueue', () => {
  it('shows the calls one at a time, in order, each with its own answer', async () => {
    const shown: Array<PendingAppCall | undefined> = [];
    const queue = createConfirmQueue((call) => shown.push(call));
    const first = queue.ask('empty_cart', { all: true });
    const second = queue.ask('checkout', {});
    expect(shown).toEqual([{ name: 'empty_cart', args: { all: true } }]);

    queue.answer(false);
    await expect(first).resolves.toBe(false);
    expect(shown.at(-1)).toEqual({ name: 'checkout', args: {} });
    queue.answer(true);
    await expect(second).resolves.toBe(true);
    expect(shown.at(-1)).toBeUndefined();
  });

  it('declines what still waits when the frame goes away, and what asks after', async () => {
    const queue = createConfirmQueue(() => undefined);
    const first = queue.ask('a', {});
    const second = queue.ask('b', {});
    queue.dispose();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await expect(queue.ask('c', {})).resolves.toBe(false);
  });

  it('gives both calls of an app their decisions through the bridge', async () => {
    const queue = createConfirmQueue(() => undefined);
    const { host, app } = await connect({
      callTool: async (name, _args, approved) =>
        approved
          ? { status: 'done', result: { content: [{ type: 'text', text: `${name} ran` }] } }
          : { status: 'approval', tool: name },
      confirm: (name, args) => queue.ask(name, args),
    });
    const first = app.callServerTool({ name: 'one', arguments: {} });
    const second = app.callServerTool({ name: 'two', arguments: {} });
    await settle();
    queue.answer(true);
    await settle();
    queue.answer(false);
    await expect(first).resolves.toEqual({ content: [{ type: 'text', text: 'one ran' }] });
    await expect(second).resolves.toMatchObject({ isError: true });
    await host.close();
  });
});
