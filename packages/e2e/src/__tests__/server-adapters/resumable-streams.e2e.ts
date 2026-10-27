import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Cogitator } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import { cogitatorApp } from '@cogitator-ai/hono';
import { parseSseFrames, parseStreamEventId, type StreamFrame } from '@cogitator-ai/server-shared';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const ollamaSkip = await ollamaSkipReason();

interface Started {
  url: string;
  stop: () => Promise<void>;
}

const adapters: Record<string, (cogitator: Cogitator) => Promise<Started>> = {
  Express: async (cogitator) => {
    const app = express();
    const server = new CogitatorServer({
      app,
      cogitator,
      agents: { TestAgent: createTestAgent() },
      config: { basePath: '/cogitator', enableSwagger: false, resumableStreams: true },
    });
    await server.init();
    const http = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const { port } = http.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/cogitator/agents/TestAgent/stream`,
      stop: () =>
        new Promise((resolve) => {
          http.closeAllConnections();
          http.close(() => resolve());
        }),
    };
  },
  Hono: async (cogitator) => {
    const root = new Hono();
    root.route(
      '/cogitator',
      cogitatorApp({ cogitator, agents: { TestAgent: createTestAgent() }, resumableStreams: true })
    );
    const http: ServerType = await new Promise((resolve) => {
      const server = serve({ fetch: root.fetch, port: 0, hostname: '127.0.0.1' }, () =>
        resolve(server)
      );
    });
    const { port } = http.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/cogitator/agents/TestAgent/stream`,
      stop: () => new Promise((resolve) => http.close(() => resolve())),
    };
  },
};

/** Starts a real run and reads `count` events of its stream, then drops the connection */
async function readThenDrop(url: string, count: number): Promise<StreamFrame[]> {
  const client = new AbortController();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: 'Count from 1 to 40, separated by commas, and nothing else.',
    }),
    signal: client.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let frames: StreamFrame[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    frames = parseSseFrames(text.slice(0, text.lastIndexOf('\n\n') + 2));
  }
  client.abort();
  await reader.cancel().catch(() => undefined);
  return frames.slice(0, count);
}

const textOf = (frames: StreamFrame[]) =>
  frames.map((frame) => (frame.event.type === 'text-delta' ? frame.event.delta : '')).join('');

for (const [name, start] of Object.entries(adapters)) {
  describe.skipIf(ollamaSkip !== null)(`${name} adapter: resumable streams`, () => {
    let cogitator: Cogitator;
    let started: Started;

    beforeAll(async () => {
      cogitator = createTestCogitator();
      started = await start(cogitator);
    });

    afterAll(async () => {
      await started?.stop();
      await cogitator?.close();
    });

    it('resumes a real streamed run after the connection dropped, through finish', async () => {
      const before = await readThenDrop(started.url, 4);
      expect(before).toHaveLength(4);
      const lastId = before.at(-1)?.id;
      expect(lastId).toBeDefined();

      const res = await fetch(started.url, {
        method: 'POST',
        headers: { 'Last-Event-ID': lastId! },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      const rest = parseSseFrames(body);

      const all = [...before, ...rest];
      expect(all.map((frame) => parseStreamEventId(frame.id ?? '')?.seq)).toEqual(
        all.map((_, at) => at + 1)
      );
      expect(new Set(all.map((frame) => parseStreamEventId(frame.id ?? '')?.streamId)).size).toBe(
        1
      );
      expect(rest.at(-1)?.event.type).toBe('finish');
      expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
      expect(textOf(all)).toMatch(/1,\s*2,\s*3/);
    });
  });
}
