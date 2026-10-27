import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateCost, initializeModels } from '@cogitator-ai/models';
import { z } from 'zod';
import type {
  ForkRequest,
  ForkPreview,
  ForkSummary,
  HostStatus,
  PluginActionResult,
  PluginPanelCallResult,
  PluginsState,
  RewindSummary,
  ThreadLineage,
  ThreadReplay,
  RunRecord,
  StudioEvent,
  ThreadRecord,
  ThreadTree,
} from '../protocol.js';
import { HostManager, HostRequestError } from './host-manager.js';
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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * What a plugin panel's page may do: run its own inline scripts and styles, show inline images and
 * fonts, nothing over the network, no forms, and in a sandbox of its own also when opened on its
 * own, so it never runs with the studio's origin.
 */
const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

const PluginEnabledBody = z.object({ enabled: z.boolean() });
const PanelCallBody = z.object({
  method: z.string().min(1).max(256),
  params: z.unknown().optional(),
});

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

/** The body as `schema` reads it, a 400 that names what is wrong otherwise. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    return field ? `"${field}": ${issue.message}` : issue.message;
  });
  throw new HttpError(400, problems.join(', '));
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

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `"${field}" must be true or false`);
  return value;
}

/**
 * A refusal of the runtime as the status it answers with: a thread a run goes on in is a
 * conflict, a point the runtime cannot rewind or fork at is a bad request.
 */
function runtimeRefusal(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const code = error instanceof HostRequestError ? error.code : undefined;
  if (
    code === 'THREAD_BUSY' ||
    code === 'WORKSPACE_BUSY' ||
    error.message.includes('has a run going on')
  ) {
    return new HttpError(409, error.message);
  }
  if (code === 'VALIDATION_ERROR') return new HttpError(400, error.message);
  return error;
}

/**
 * A refusal of a plugin request as the status it answers with: an unknown plugin or panel is not
 * found, a project whose runtime has no plugins to change is a conflict, a bad request stays one.
 */
function pluginRefusal(error: unknown): unknown {
  if (!(error instanceof HostRequestError)) return error;
  switch (error.code) {
    case 'PLUGIN_NOT_FOUND':
      return new HttpError(404, error.message);
    case 'PLUGINS_UNAVAILABLE':
    case 'PLUGINS_NOT_CONFIGURED':
      return new HttpError(409, error.message);
    case 'VALIDATION_ERROR':
      return new HttpError(400, error.message);
    default:
      return error;
  }
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
      if (change.thread) broadcastThread(change.thread);
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
    onPlugins: (plugins) => broadcast({ type: 'plugins', plugins }),
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

  /** The active branch the studio keeps of a thread, for the host to replay after a restart */
  function replayOf(threadId: string): { replay?: ThreadReplay; lineage?: ThreadLineage[] } {
    const replay = store.replay(threadId);
    const lineage = store.lineage(threadId);
    return { ...(replay && { replay }), ...(lineage.length > 0 && { lineage }) };
  }

  /** A plugin request to the host, its refusals answered with their own status. */
  function pluginRequest<T>(request: Parameters<HostManager['request']>[0]): Promise<T> {
    return manager.request<T>(request).catch((error: unknown) => {
      throw pluginRefusal(error);
    });
  }

  function runOr404(id: string): RunRecord {
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, `There is no run ${id}`);
    return run;
  }

  function threadOr404(id: string): ThreadRecord {
    const thread = store.getThread(id);
    if (!thread) throw new HttpError(404, `There is no thread ${id}`);
    return thread;
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
      case 'GET /stats':
        return send(res, 200, store.stats());
      case 'GET /runs': {
        const kind = url.searchParams.get('kind');
        return send(res, 200, {
          runs: store.listRuns({
            target: url.searchParams.get('target') ?? undefined,
            kind:
              kind === 'agent' || kind === 'workflow' || kind === 'fork' || kind === 'swarm'
                ? kind
                : undefined,
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
      case 'GET /threads/:id/tree': {
        const thread = store.getThread(parts[1]);
        if (!thread) throw new HttpError(404, `There is no thread ${parts[1]}`);
        const tree = await manager.request<ThreadTree>({
          type: 'thread.tree',
          threadId: thread.id,
          agent: thread.agent,
          history: store.history(thread.id),
          ...replayOf(thread.id),
        });
        return send(res, 200, store.attribute(tree));
      }
      case 'POST /threads/:id/rewind': {
        const thread = threadOr404(parts[1]);
        const body = await readJson(req);
        const entryId = requireString(body, 'entryId');
        const files = optionalBoolean(body, 'files');
        const memory = optionalBoolean(body, 'memory');
        const dryRun = optionalBoolean(body, 'dryRun');
        const force = optionalBoolean(body, 'force');
        const summary = await manager
          .request<RewindSummary>({
            type: 'thread.rewind',
            threadId: thread.id,
            agent: thread.agent,
            history: store.history(thread.id),
            ...replayOf(thread.id),
            entryId,
            ...(files !== undefined && { files }),
            ...(memory !== undefined && { memory }),
            ...(dryRun !== undefined && { dryRun }),
            ...(force !== undefined && { force }),
          })
          .catch((error: unknown) => {
            throw runtimeRefusal(error);
          });
        const { replay, ...reported } = summary;
        if (replay) store.keepReplay(thread.id, replay);
        const changed = summary.conversation.rewound
          ? store.markRewound(thread.id, summary.conversation.cut)
          : thread;
        if (summary.conversation.rewound) broadcastThread(changed);
        return send(res, 200, { ...reported, thread: changed ?? thread });
      }
      case 'POST /threads/:id/fork': {
        const thread = threadOr404(parts[1]);
        const body = await readJson(req);
        const entryId = requireString(body, 'entryId');
        const files = optionalBoolean(body, 'files');
        const dryRun = optionalBoolean(body, 'dryRun');
        const force = optionalBoolean(body, 'force');
        const fork = await manager
          .request<ForkSummary | ForkPreview>({
            type: 'thread.fork',
            threadId: thread.id,
            agent: thread.agent,
            history: store.history(thread.id),
            ...replayOf(thread.id),
            entryId,
            newThreadId: `studio_${randomUUID()}`,
            ...(files !== undefined && { files }),
            ...(dryRun !== undefined && { dryRun }),
            ...(force !== undefined && { force }),
          })
          .catch((error: unknown) => {
            throw runtimeRefusal(error);
          });
        if ('dryRun' in fork) return send(res, 200, fork);
        const { replay, ...made } = fork;
        const forked = store.addForkedThread(thread, {
          threadId: fork.threadId,
          entryId,
          base: fork.base,
          ...(replay && { replay }),
        });
        broadcastThread(forked);
        return send(res, 201, { ...made, thread: forked });
      }
      case 'GET /plugins':
        return send(res, 200, await pluginRequest<PluginsState>({ type: 'plugins.list' }));
      case 'POST /plugins/:id/reload': {
        await readJson(req);
        return send(
          res,
          200,
          await pluginRequest<PluginActionResult>({ type: 'plugins.reload', plugin: parts[1] })
        );
      }
      case 'POST /plugins/:id/enabled': {
        const { enabled } = parseBody(PluginEnabledBody, await readJson(req));
        return send(
          res,
          200,
          await pluginRequest<PluginActionResult>({
            type: 'plugins.enable',
            plugin: parts[1],
            enabled,
          })
        );
      }
      case 'GET /plugins/:id/panels/:id': {
        const { html } = await pluginRequest<{ html: string }>({
          type: 'plugins.panel',
          plugin: parts[1],
          panel: parts[3],
        });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(html),
          'x-content-type-options': 'nosniff',
          'content-security-policy': PANEL_CSP,
          'referrer-policy': 'no-referrer',
          'cross-origin-resource-policy': 'same-origin',
        });
        res.end(html);
        return;
      }
      case 'POST /plugins/:id/panels/:id/call': {
        const { method: handler, params } = parseBody(PanelCallBody, await readJson(req));
        return send(
          res,
          200,
          await pluginRequest<PluginPanelCallResult>({
            type: 'plugins.call',
            plugin: parts[1],
            panel: parts[3],
            method: handler,
            ...(params !== undefined && { params }),
          })
        );
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
          ...replayOf(threadId),
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
            ...(optionalBoolean(body, 'remember') && { remember: true }),
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
        if (
          method === 'POST' &&
          parts[0] === 'swarms' &&
          parts.length === 3 &&
          parts[2] === 'run'
        ) {
          const body = await readJson(req);
          return send(
            res,
            202,
            await manager.request({
              type: 'swarm.run',
              swarm: parts[1],
              input: requireString(body, 'input'),
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
