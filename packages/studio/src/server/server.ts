import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateCost, initializeModels } from '@cogitator-ai/models';
import type { ForkRequest, HostStatus, RunRecord, StudioEvent, ThreadRecord } from '../protocol.js';
import { HostManager } from './host-manager.js';
import { StudioStore, type Pricer } from './store.js';

export interface StudioOptions {
  projectDir: string;
  /** Interface to listen on, `127.0.0.1` unless the studio should be reachable from other machines. */
  host?: string;
  /** Port to listen on (default 4321); the next free one is taken when it is busy, unless `strictPort`. */
  port?: number;
  strictPort?: boolean;
  /**
   * Token every request must carry when the studio listens beyond loopback.
   * A random one is made when it is not given.
   */
  token?: string;
  /** Reload the project when its files change (default `true`). */
  watch?: boolean;
  /** Where the history lives, `.cogitator/studio` in the project by default. */
  studioDir?: string;
  /** Output of the project's code and studio notices. */
  log?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Prices model calls; the model registry by default. */
  price?: Pricer;
}

export interface StudioHandle {
  url: string;
  port: number;
  /** The token in `url`, when the studio listens beyond loopback. */
  token?: string;
  store: StudioStore;
  hostStatus(): HostStatus;
  /** Resolves once the project is loaded, rejects when it failed. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MAX_BODY_BYTES = 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function uiDirectory(): string {
  return fileURLToPath(new URL('../ui/', import.meta.url));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new HttpError(415, 'Send JSON with content-type application/json');
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'The request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '')
    throw new HttpError(400, `"${field}" is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `"${field}" must be a string`);
  return value;
}

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? '';
  return /(?:^|;\s*)cogitator_studio=([^;]+)/.exec(cookie)?.[1];
}

function hostnameOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  if (header.startsWith('[')) return header.slice(1, header.indexOf(']'));
  return header.split(':')[0];
}

function listen(server: Server, host: string, port: number, strict: boolean): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const attempt = (candidate: number, left: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && !strict && left > 0) attempt(candidate + 1, left - 1);
        else reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolvePort(typeof address === 'object' && address ? address.port : candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, host);
    };
    attempt(port, 20);
  });
}

/**
 * Starts Cogitator Studio for the project in `projectDir`: the runtime host
 * that runs the project, and the web app to chat with its agents, read
 * traces and costs, approve tool calls, run workflows and fork runs.
 */
export async function startStudio(options: StudioOptions): Promise<StudioHandle> {
  const projectDir = resolve(options.projectDir);
  const studioDir = resolve(options.studioDir ?? join(projectDir, '.cogitator', 'studio'));
  const host = options.host ?? '127.0.0.1';
  const exposed = !LOOPBACK.has(host);
  const token = exposed ? (options.token ?? randomBytes(18).toString('base64url')) : undefined;
  const log = options.log ?? (() => undefined);

  if (!options.price) {
    initializeModels().catch(() => undefined);
  }
  const price: Pricer = options.price ?? ((model, usage) => calculateCost(model, usage));
  const store = new StudioStore(studioDir, price);
  const projectName = (() => {
    try {
      const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8')) as {
        name?: unknown;
      };
      return typeof manifest.name === 'string' ? manifest.name : basename(projectDir);
    } catch {
      return basename(projectDir);
    }
  })();
  const clients = new Set<ServerResponse>();

  const broadcast = (event: StudioEvent) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(data);
  };
  const broadcastRuns = (runs: readonly RunRecord[]) => {
    for (const run of runs) broadcast({ type: 'run', run });
  };
  const broadcastThread = (thread: ThreadRecord | undefined) => {
    if (thread) broadcast({ type: 'thread', thread });
  };

  const manager = new HostManager({
    projectDir,
    studioDir,
    watch: options.watch,
    onStatus: (status) => {
      if (status.state === 'ready') store.setRegistry(status.registry);
      broadcast({ type: 'host', status });
    },
    onEvent: (event) => {
      const change = store.apply(event);
      broadcastRuns(change.runs);
      if (change.token) broadcast({ type: 'token', ...change.token });
      if (change.reasoning) broadcast({ type: 'reasoning', ...change.reasoning });
      if (
        event.type === 'run.started' &&
        event.threadId &&
        event.kind === 'agent' &&
        event.rootRunId === event.runId
      ) {
        broadcastThread(store.addRunToThread(event.threadId, event.runId));
      }
    },
    onLost: (reason) => broadcastRuns(store.abandonRunning(reason)),
    onOutput: log,
  });

  const allowedHosts = (port: number) => {
    const names = new Set<string>(['127.0.0.1', 'localhost', '::1']);
    if (exposed && host !== '0.0.0.0' && host !== '::') names.add(host);
    return { names, port };
  };

  let port = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent)
        send(res, status, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (!exposed) {
      const allowed = allowedHosts(port);
      const hostname = hostnameOf(req.headers.host);
      if (!hostname || !allowed.names.has(hostname)) {
        throw new HttpError(403, 'Cogitator Studio answers on localhost only');
      }
    } else if (token) {
      const given =
        url.searchParams.get('token') ??
        cookieToken(req) ??
        req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!sameToken(given ?? undefined, token))
        throw new HttpError(401, 'Open the studio with the URL cogitator dev printed');
      if (url.searchParams.has('token')) {
        res.setHeader('set-cookie', `cogitator_studio=${token}; HttpOnly; SameSite=Strict; Path=/`);
      }
    }

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string | undefined;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = undefined;
        }
        if (originHost !== req.headers.host)
          throw new HttpError(403, 'Requests from other sites are refused');
      }
    }

    if (path.startsWith('/api/')) return api(req, res, url);
    return serveUi(res, path);
  }

  function serveUi(res: ServerResponse, path: string): void {
    const root = uiDirectory();
    const index = join(root, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('The studio UI is not built: run pnpm --filter @cogitator-ai/studio build');
      return;
    }
    const candidate = normalize(join(root, decodeURIComponent(path)));
    const file =
      candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : index;
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const immutable = basename(file) !== 'index.html' && file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      ...(type.startsWith('text/html') && {
        'content-security-policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      }),
    });
    res.end(readFileSync(file));
  }

  function runOr404(id: string): RunRecord {
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, `There is no run ${id}`);
    return run;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const route = `${method} /${parts.map((part, i) => (i % 2 === 1 && parts[0] !== 'workflows' ? ':id' : part)).join('/')}`;

    if (method === 'GET' && parts[0] === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(
        `data: ${JSON.stringify({ type: 'host', status: manager.current } satisfies StudioEvent)}\n\n`
      );
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    switch (route) {
      case 'GET /state':
        return send(res, 200, {
          host: manager.current,
          project: projectName,
          runs: store.listRuns({ limit: 100 }),
          threads: store.listThreads(),
        });
      case 'GET /runs': {
        const kind = url.searchParams.get('kind');
        return send(res, 200, {
          runs: store.listRuns({
            target: url.searchParams.get('target') ?? undefined,
            kind: kind === 'agent' || kind === 'workflow' || kind === 'fork' ? kind : undefined,
            q: url.searchParams.get('q') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 200) || 200,
          }),
        });
      }
      case 'GET /runs/:id': {
        const tree = store.getRunTree(parts[1]);
        if (!tree) throw new HttpError(404, `There is no run ${parts[1]}`);
        return send(res, 200, tree);
      }
      case 'GET /threads':
        return send(res, 200, {
          threads: store.listThreads(url.searchParams.get('agent') ?? undefined),
        });
      case 'GET /threads/:id': {
        const thread = store.getThread(parts[1]);
        if (!thread) throw new HttpError(404, `There is no thread ${parts[1]}`);
        const runs = thread.runs
          .map((id) => store.getRun(id))
          .filter((run): run is RunRecord => run !== undefined);
        return send(res, 200, { thread, runs });
      }
      case 'POST /chat': {
        const body = await readJson(req);
        const agent = requireString(body, 'agent');
        const input = requireString(body, 'input');
        const threadId = optionalString(body, 'threadId') ?? `studio_${randomUUID()}`;
        const thread = store.touchThread(threadId, agent, input);
        broadcastThread(thread);
        const { runId } = await manager.request<{ runId: string }>({
          type: 'chat',
          agent,
          input,
          threadId,
          history: store.history(threadId),
        });
        broadcastThread(store.addRunToThread(threadId, runId));
        return send(res, 202, { runId, threadId });
      }
      case 'POST /runs/:id/stop': {
        runOr404(parts[1]);
        return send(res, 200, await manager.request({ type: 'stop', runId: parts[1] }));
      }
      case 'POST /approvals/:id': {
        const body = await readJson(req);
        if (typeof body.approved !== 'boolean')
          throw new HttpError(400, '"approved" must be true or false');
        return send(
          res,
          200,
          await manager.request({
            type: 'approve',
            approvalId: parts[1],
            approved: body.approved,
            ...(optionalString(body, 'reason') && { reason: optionalString(body, 'reason') }),
          })
        );
      }
      case 'POST /runs/:id/fork': {
        const run = runOr404(parts[1]);
        if (run.kind === 'workflow')
          throw new HttpError(400, 'Workflow runs are rerun from a node, not forked');
        if (run.status !== 'completed' || !run.steps?.length) {
          throw new HttpError(409, 'Only a completed run with steps can be forked');
        }
        const body = await readJson(req);
        const step = body.step;
        if (typeof step !== 'number' || !Number.isInteger(step) || step < 0) {
          throw new HttpError(400, '"step" must be a step index of the run');
        }
        const toolResults = body.toolResults;
        if (
          toolResults !== undefined &&
          (typeof toolResults !== 'object' || toolResults === null || Array.isArray(toolResults))
        ) {
          throw new HttpError(400, '"toolResults" must map tool names to results');
        }
        const fork: ForkRequest = {
          step,
          ...(optionalString(body, 'input') !== undefined && {
            input: optionalString(body, 'input'),
          }),
          ...(optionalString(body, 'context') !== undefined && {
            context: optionalString(body, 'context'),
          }),
          ...(toolResults !== undefined && { toolResults: toolResults as Record<string, unknown> }),
        };
        return send(res, 202, await manager.request({ type: 'fork', run, fork }));
      }
      case 'POST /runs/:id/rerun': {
        const run = runOr404(parts[1]);
        if (run.kind !== 'workflow')
          throw new HttpError(400, 'Only workflow runs are rerun from a node');
        const body = await readJson(req);
        return send(
          res,
          202,
          await manager.request({
            type: 'workflow.rerun',
            run,
            fromNode: requireString(body, 'fromNode'),
          })
        );
      }
      default:
        if (
          method === 'POST' &&
          parts[0] === 'workflows' &&
          parts.length === 3 &&
          parts[2] === 'run'
        ) {
          const body = await readJson(req);
          return send(
            res,
            202,
            await manager.request({
              type: 'workflow.run',
              workflow: parts[1],
              input: body.input ?? {},
            })
          );
        }
        throw new HttpError(404, `No route ${method} ${url.pathname}`);
    }
  }

  port = await listen(server, host, options.port ?? 4321, options.strictPort === true);
  manager.start();

  const displayHost = exposed
    ? host === '0.0.0.0' || host === '::'
      ? 'localhost'
      : host
    : 'localhost';
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}/${token ? `?token=${token}` : ''}`;

  return {
    url,
    port,
    ...(token && { token }),
    store,
    hostStatus: () => manager.current,
    ready: () => manager.ready(),
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await manager.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
