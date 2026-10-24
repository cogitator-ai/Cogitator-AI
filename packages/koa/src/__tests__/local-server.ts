import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach } from 'vitest';

const open = new Set<Server>();

/**
 * A server for `app` listening on 127.0.0.1, for supertest. supertest's own server listens on
 * `::`, and macOS lets a `::` listener share its port with a 127.0.0.1 listener of another test
 * worker: the requests supertest sends to 127.0.0.1 then reach that server, and fail with
 * `ECONNRESET` once it closes. Listeners on 127.0.0.1 never share a port. Closed after each test
 */
export async function serve(app: {
  callback(): (req: IncomingMessage, res: ServerResponse) => unknown;
}): Promise<Server> {
  const server = createServer(app.callback());
  open.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

afterEach(async () => {
  const servers = [...open];
  open.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});
