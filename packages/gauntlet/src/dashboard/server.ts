import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { GauntletEvent, RunReport } from '../runner/types.js';

const PAGE = new URL('./index.html', import.meta.url);
const HEARTBEAT_MS = 15_000;

export interface Dashboard {
  url: string;
  publish(event: GauntletEvent): void;
  close(): Promise<void>;
}

/**
 * Serves the live dashboard: `/` the page, `/events` a server-sent event stream that starts with
 * the current snapshot (so a page opened mid-run catches up), `/report` the snapshot as JSON.
 */
export async function startDashboard(port: number, snapshot: () => RunReport): Promise<Dashboard> {
  const clients = new Set<ServerResponse>();
  const send = (
    response: ServerResponse,
    event: GauntletEvent | { type: 'snapshot'; report: RunReport }
  ) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(await readFile(PAGE, 'utf8'));
      return;
    }
    if (path === '/report') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(snapshot()));
      return;
    }
    if (path === '/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      send(response, { type: 'snapshot', report: snapshot() });
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    response.writeHead(404).end();
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://localhost:${port}`,
    publish(event) {
      for (const client of clients) send(client, event);
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
