import { createServer, type IncomingMessage } from 'node:http';
import {
  createServer as createHttp2Server,
  type Http2ServerRequest,
  type Http2Session,
} from 'node:http2';
import type { AddressInfo } from 'node:net';

/** A request the fake provider received. */
export interface FakeProviderRequest {
  method: string;
  /** Path with the query string, e.g. `/v1/chat/completions` */
  path: string;
  /** Header names in lower case */
  headers: Record<string, string>;
  /** The body parsed as JSON, or the raw text when it is not JSON */
  body: unknown;
}

/** How the fake provider answers one request. */
export type FakeProviderReply =
  | {
      type: 'json';
      status?: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | {
      type: 'stream';
      status?: number;
      contentType: string;
      /** Written one by one, each flushed on its own */
      chunks: readonly (string | Uint8Array)[];
      headers?: Record<string, string>;
      /** Keep the response open after the chunks, until the client goes away */
      hang?: boolean;
    }
  /** Never answer: the request stays open until the client goes away */
  | { type: 'hang' };

export type FakeProviderHandler = (request: FakeProviderRequest) => FakeProviderReply;

/**
 * An HTTP server standing in for a model provider. Each request is answered by the handler set
 * with `reply`, so a backend pointed at `url` talks to it through its real SDK and wire format.
 */
export interface FakeProvider {
  /** The base URL, e.g. `http://127.0.0.1:53111` */
  readonly url: string;
  /** Every request received so far, oldest first */
  readonly requests: readonly FakeProviderRequest[];
  /** Sets how the next requests are answered */
  reply(handler: FakeProviderHandler): void;
  /** Resolves once a request has arrived, with that request */
  nextRequest(): Promise<FakeProviderRequest>;
  /** Resolves once the connection of the latest request has closed */
  latestClosed(): Promise<void>;
  /** Stops the server and drops open connections */
  close(): Promise<void>;
}

export interface FakeProviderOptions {
  /**
   * Speak HTTP/2 without TLS (h2c with prior knowledge) instead of HTTP/1.1, for clients that
   * only speak HTTP/2, such as the AWS SDK's Bedrock Runtime client.
   */
  http2?: boolean;
}

type Request = IncomingMessage | Http2ServerRequest;

/** What answering a request takes, over HTTP/1.1 (`ServerResponse`) and HTTP/2 (`Http2ServerResponse`). */
interface Response {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string | Uint8Array): unknown;
  end(chunk: string): unknown;
  end(): unknown;
  once(event: 'close', listener: () => void): unknown;
  /** HTTP/1.1 only: HTTP/2 sends the headers with `writeHead` */
  flushHeaders?(): void;
}

/** Starts a fake provider on a free local port. */
export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const requests: FakeProviderRequest[] = [];
  const waiting: Array<(request: FakeProviderRequest) => void> = [];
  const sessions = new Set<Http2Session>();
  let latestClosed: Promise<void> = Promise.resolve();
  let handler: FakeProviderHandler = () => ({
    type: 'json',
    status: 500,
    body: { error: { message: 'The fake provider has no reply set' } },
  });

  const onRequest = (req: Request, res: Response) => {
    const closed = new Promise<void>((resolve) => res.once('close', () => resolve()));
    latestClosed = closed;
    void readBody(req).then((text) => {
      const request: FakeProviderRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: flatHeaders(req),
        body: parseBody(text),
      };
      requests.push(request);
      waiting.splice(0).forEach((resolve) => resolve(request));
      let reply: FakeProviderReply;
      try {
        reply = handler(request);
      } catch (error) {
        reply = {
          type: 'json',
          status: 500,
          body: {
            error: {
              message: `The fake provider's handler failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
        };
      }
      answer(res, closed, reply);
    });
  };

  const server = options.http2 ? createHttp2Server(onRequest) : createServer(onRequest);
  if (options.http2) {
    server.on('session', (session: Http2Session) => {
      sessions.add(session);
      session.once('close', () => sessions.delete(session));
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply(next) {
      handler = next;
    },
    nextRequest() {
      return new Promise((resolve) => waiting.push(resolve));
    },
    latestClosed() {
      return latestClosed;
    },
    close() {
      if ('closeAllConnections' in server) server.closeAllConnections();
      for (const session of sessions) session.destroy();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

function answer(res: Response, closed: Promise<void>, reply: FakeProviderReply): void {
  switch (reply.type) {
    case 'hang':
      return;
    case 'json':
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body));
      return;
    case 'stream': {
      res.writeHead(reply.status ?? 200, {
        'content-type': reply.contentType,
        'cache-control': 'no-cache',
        ...reply.headers,
      });
      res.flushHeaders?.();
      let gone = false;
      void closed.then(() => {
        gone = true;
      });
      void writeChunks(res, reply.chunks, () => gone).then(() => {
        if (!reply.hang && !gone) res.end();
      });
    }
  }
}

async function writeChunks(
  res: Response,
  chunks: readonly (string | Uint8Array)[],
  gone: () => boolean
): Promise<void> {
  for (const chunk of chunks) {
    if (gone()) return;
    res.write(chunk);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function readBody(req: Request): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function flatHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !name.startsWith(':')) {
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return headers;
}
