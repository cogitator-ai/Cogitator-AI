import {
  siBun,
  siCloudflareworkers,
  siDeno,
  siExpress,
  siFastify,
  siHono,
  siKoa,
  siNextdotjs,
  siVercel,
  type SimpleIcon,
} from 'simple-icons';
import type { CodeLang } from '../../highlight';
import type { RouteItem, StreamLine, StreamScript } from './types';
import {
  AGENT_TS,
  AI_SDK_TS,
  DENO_TS,
  EXPRESS_TS,
  FASTIFY_TS,
  HONO_TS,
  KOA_TS,
  NEXT_CHAT_TSX,
  NEXT_ROUTE_TS,
  OPENAI_TS,
  TETSU_TS,
  WORKER_TS,
  WRANGLER_JSONC,
} from './snippets';

export interface RuntimeFileSpec {
  name: string;
  code: string;
  lang: CodeLang;
}

export interface RuntimeTabSpec {
  id: string;
  label: string;
  /** `null` renders a neutral glyph (OpenAI has no Simple Icons entry). */
  icon: SimpleIcon | null;
  runtime: string;
  install: string;
  files: RuntimeFileSpec[];
  routes: RouteItem[];
  stream: StreamScript;
  example: string;
  docsHref: string;
}

const PROMPT = 'What is 123 * 456?';
const ANSWER = ['123 × 456 is', ' 56,088', '.'];

const agentFile = (name = 'agent.ts'): RuntimeFileSpec => ({ name, code: AGENT_TS, lang: 'ts' });

/** The events every Cogitator adapter streams for a run with one tool call (server-shared protocol). */
function cogitatorEvents(finish: string): StreamLine[] {
  return [
    { label: 'start', value: 'msg_m4x2k9', tone: 'meta' },
    { label: 'tool-call-start', value: 'calculator', tone: 'tool' },
    { label: 'tool-call-delta', value: '{"expression":"123 * 456"}', tone: 'tool' },
    { label: 'tool-call-end', tone: 'tool' },
    { label: 'tool-result', value: '{"result":56088,"expression":"123 * 456"}', tone: 'tool' },
    { label: 'text-start', value: 'txt_m4x2kc', tone: 'meta' },
    ...ANSWER.map((delta) => ({
      label: 'text-delta',
      value: JSON.stringify(delta),
      tone: 'text' as const,
      delta,
    })),
    { label: 'text-end', tone: 'meta' },
    { label: 'finish', value: finish, tone: 'meta' },
    { label: '[DONE]', tone: 'meta' },
  ];
}

function agentStream(base: string): StreamScript {
  return {
    request: {
      method: 'POST',
      target: `${base}/agents/assistant/stream`,
      body: JSON.stringify({ input: PROMPT }),
    },
    response: '200 · text/event-stream',
    wire: 'data: {"type":"…"}',
    events: cogitatorEvents('usage · 243 tokens'),
  };
}

interface AdapterRouteOptions {
  ws: { path?: string; label: string; optIn?: string };
  docs: { path?: string; label: string; optIn?: string };
  resumeStream?: boolean;
}

/** The REST surface shared by the Express, Fastify, Hono, Koa and Tetsu adapters. */
function adapterRoutes(base: string, options: AdapterRouteOptions): RouteItem[] {
  return [
    { method: 'POST', path: `${base}/agents/:name/run`, label: 'Run an agent, JSON reply' },
    { method: 'POST', path: `${base}/agents/:name/stream`, label: 'Same run as an SSE stream' },
    {
      method: 'POST',
      path: `${base}/agents/:name/resume${options.resumeStream ? '[/stream]' : ''}`,
      label: 'Resume a run paused for approval',
    },
    {
      method: 'GET',
      path: `${base}/threads/:id`,
      label: 'Memory threads · POST messages, DELETE',
    },
    {
      method: 'POST',
      path: `${base}/workflows/:name/stream`,
      label: 'Workflows and swarms, run or streamed',
    },
    {
      method: 'WS',
      path: options.ws.path ?? `${base}/ws`,
      label: options.ws.label,
      optIn: options.ws.optIn,
    },
    {
      method: 'GET',
      path: options.docs.path ?? `${base}/docs`,
      label: options.docs.label,
      optIn: options.docs.optIn,
    },
  ];
}

/** Routes of the Hono adapter on an edge runtime, where the snippet configures no memory. */
function edgeRoutes(base: string, upgradeFrom: string): RouteItem[] {
  return [
    { method: 'POST', path: `${base}/agents/:name/run`, label: 'Run an agent, JSON reply' },
    { method: 'POST', path: `${base}/agents/:name/stream`, label: 'Same run as an SSE stream' },
    { method: 'GET', path: `${base}/agents`, label: 'Agents with description and tools' },
    { method: 'GET', path: `${base}/health`, label: 'Liveness, plus /ready' },
    {
      method: 'WS',
      path: `${base}/ws`,
      label: 'Agent runs over a socket',
      optIn: `upgradeWebSocket from ${upgradeFrom}`,
    },
    {
      method: 'GET',
      path: `${base}/docs`,
      label: 'Swagger UI and /openapi.json',
      optIn: 'enableSwagger',
    },
  ];
}

export const RUNTIME_TABS: RuntimeTabSpec[] = [
  {
    id: 'express',
    label: 'Express',
    icon: siExpress,
    runtime: 'Node.js',
    install: '@cogitator-ai/express',
    files: [{ name: 'server.ts', code: EXPRESS_TS, lang: 'ts' }, agentFile()],
    routes: adapterRoutes('/cogitator', {
      ws: { label: 'Agent runs over a socket, via attachWebSocket' },
      docs: { label: 'Swagger UI and /openapi.json, on by default' },
    }),
    stream: agentStream('/cogitator'),
    example: 'examples/integrations/01-express-server.ts',
    docsHref: '/docs/server-adapters/express',
  },
  {
    id: 'fastify',
    label: 'Fastify',
    icon: siFastify,
    runtime: 'Node.js',
    install: '@cogitator-ai/fastify',
    files: [{ name: 'server.ts', code: FASTIFY_TS, lang: 'ts' }, agentFile()],
    routes: adapterRoutes('/cogitator', {
      ws: { label: 'Agent runs over a socket', optIn: '@fastify/websocket' },
      docs: { label: 'Swagger UI and /docs/json', optIn: '@fastify/swagger-ui' },
    }),
    stream: agentStream('/cogitator'),
    example: 'examples/integrations/02-fastify-server.ts',
    docsHref: '/docs/server-adapters/fastify',
  },
  {
    id: 'hono',
    label: 'Hono',
    icon: siHono,
    runtime: 'Node · Bun · Deno · Workers',
    install: '@cogitator-ai/hono',
    files: [{ name: 'server.ts', code: HONO_TS, lang: 'ts' }, agentFile()],
    routes: adapterRoutes('/cogitator', {
      ws: {
        label: 'Agent, workflow and swarm runs over a socket',
        optIn: "your runtime's upgradeWebSocket",
      },
      docs: { label: 'Swagger UI and /openapi.json' },
    }),
    stream: agentStream('/cogitator'),
    example: 'examples/integrations/03-hono-server.ts',
    docsHref: '/docs/server-adapters/hono',
  },
  {
    id: 'koa',
    label: 'Koa',
    icon: siKoa,
    runtime: 'Node.js',
    install: '@cogitator-ai/koa',
    files: [{ name: 'server.ts', code: KOA_TS, lang: 'ts' }, agentFile()],
    routes: adapterRoutes('', {
      ws: { label: 'Agent, workflow and swarm runs, via setupWebSocket' },
      docs: { label: 'Swagger UI and /openapi.json' },
    }),
    stream: agentStream(''),
    example: 'examples/integrations/04-koa-server.ts',
    docsHref: '/docs/server-adapters/koa',
  },
  {
    id: 'next',
    label: 'Next.js',
    icon: siNextdotjs,
    runtime: 'App Router · Next 14–16',
    install: '@cogitator-ai/next',
    files: [
      { name: 'app/api/chat/route.ts', code: NEXT_ROUTE_TS, lang: 'ts' },
      { name: 'chat.tsx', code: NEXT_CHAT_TSX, lang: 'tsx' },
      agentFile('lib/agent.ts'),
    ],
    routes: [
      {
        method: 'POST',
        path: '/api/chat',
        label: 'createChatHandler · text, tool and finish events over SSE',
      },
      {
        method: 'HOOK',
        path: 'useCogitatorChat()',
        label: 'Messages, send, stop; adopts the threadId from finish',
      },
      {
        method: 'POST',
        path: '/api/agent',
        label: 'One JSON run per request',
        optIn: 'createAgentHandler',
      },
      {
        method: 'HOOK',
        path: 'useCogitatorAgent()',
        label: 'Client side of the JSON handler',
      },
      {
        method: 'POST',
        path: '/api/chat/resume',
        label: 'Answer pending tool approvals',
        optIn: 'createResumeHandler',
      },
    ],
    stream: {
      request: {
        method: 'POST',
        target: '/api/chat',
        body: '{"messages":[{"role":"user","content":"What is 123 * 456?"}]}',
      },
      response: '200 · text/event-stream',
      wire: 'data: {"type":"…"}',
      events: cogitatorEvents('usage · threadId'),
    },
    example: 'examples/integrations/05-nextjs-handler.ts',
    docsHref: '/docs/integrations/nextjs',
  },
  {
    id: 'tetsu',
    label: 'Tetsu',
    icon: siBun,
    runtime: 'Bun ≥ 1.4',
    install: '@cogitator-ai/tetsu',
    files: [{ name: 'server.ts', code: TETSU_TS, lang: 'ts' }, agentFile()],
    routes: adapterRoutes('/cogitator', {
      resumeStream: true,
      ws: { label: 'Agent runs over a socket, websocket: true' },
      docs: { path: '/docs', label: 'Scalar UI and /openapi.json from docs()' },
    }),
    stream: agentStream('/cogitator'),
    example: 'examples/integrations/08-tetsu-server.ts',
    docsHref: '/docs/server-adapters/tetsu',
  },
  {
    id: 'deno',
    label: 'Deno',
    icon: siDeno,
    runtime: 'Deno · Hono adapter',
    install: '@cogitator-ai/hono',
    files: [{ name: 'main.ts', code: DENO_TS, lang: 'ts' }],
    routes: edgeRoutes('/cogitator', 'hono/deno'),
    stream: agentStream('/cogitator'),
    example: 'examples/integrations/09-deno-server.ts',
    docsHref: '/docs/deployment/edge#deno',
  },
  {
    id: 'workers',
    label: 'Workers',
    icon: siCloudflareworkers,
    runtime: 'Cloudflare · Hono adapter',
    install: '@cogitator-ai/hono',
    files: [
      { name: 'src/index.ts', code: WORKER_TS, lang: 'ts' },
      { name: 'wrangler.jsonc', code: WRANGLER_JSONC, lang: 'json' },
    ],
    routes: edgeRoutes('', 'hono/cloudflare-workers'),
    stream: agentStream(''),
    example: 'examples/integrations/10-cloudflare-worker',
    docsHref: '/docs/deployment/edge#cloudflare-workers',
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    icon: null,
    runtime: 'Assistants API · Fastify',
    install: '@cogitator-ai/openai-compat',
    files: [{ name: 'openai.ts', code: OPENAI_TS, lang: 'ts' }, agentFile()],
    routes: [
      { method: 'POST', path: '/v1/assistants', label: 'Assistants with Cogitator models' },
      { method: 'POST', path: '/v1/threads', label: 'Threads and messages' },
      {
        method: 'POST',
        path: '/v1/threads/:id/runs',
        label: 'Runs; stream: true answers with SSE',
      },
      {
        method: 'POST',
        path: '/v1/threads/:id/runs/:run_id/submit_tool_outputs',
        label: 'Client-side function tools',
      },
      { method: 'POST', path: '/v1/files', label: 'Upload, list, download, delete' },
      { method: 'GET', path: '/v1/models', label: 'One model, cogitator → defaultModel' },
    ],
    stream: {
      request: {
        method: 'POST',
        target: '/v1/threads/thread_8f2k/runs',
        body: '{"assistant_id":"asst_3jd1","stream":true}',
      },
      response: '200 · text/event-stream',
      wire: 'event: thread.message.delta',
      events: [
        { label: 'thread.run.created', value: 'run_6qk2', tone: 'meta' },
        { label: 'thread.run.queued', tone: 'meta' },
        { label: 'thread.run.in_progress', tone: 'meta' },
        { label: 'thread.message.created', tone: 'meta' },
        { label: 'thread.message.in_progress', tone: 'meta' },
        ...ANSWER.map((delta) => ({
          label: 'thread.message.delta',
          value: JSON.stringify(delta),
          tone: 'text' as const,
          delta,
        })),
        { label: 'thread.message.completed', tone: 'meta' },
        { label: 'thread.run.completed', tone: 'meta' },
        { label: 'done', value: '[DONE]', tone: 'meta' },
      ],
    },
    example: 'examples/integrations/06-openai-compat.ts',
    docsHref: '/docs/integrations/openai-compat',
  },
  {
    id: 'ai-sdk',
    label: 'AI SDK',
    icon: siVercel,
    runtime: 'ai@4 – ai@7',
    install: '@cogitator-ai/ai-sdk',
    files: [{ name: 'stream.ts', code: AI_SDK_TS, lang: 'ts' }, agentFile()],
    routes: [
      {
        method: 'FN',
        path: 'cogitatorModel(cog, agent)',
        label: 'An agent as a LanguageModel for generateText and streamText',
      },
      {
        method: 'FN',
        path: 'createCogitatorProvider()',
        label: 'A provider that resolves agents by name',
      },
      {
        method: 'FN',
        path: 'fromAISDK(model)',
        label: 'Any AI SDK model as a Cogitator backend',
      },
      {
        method: 'FN',
        path: 'toAISDKTool() · fromAISDKTool()',
        label: 'Tools converted in both directions',
      },
    ],
    stream: {
      request: {
        method: 'streamText',
        target: 'cogitatorModel(cogitator, assistant)',
      },
      response: 'agent loop runs inside one model call',
      wire: 'result.textStream',
      events: [
        ...ANSWER.map((delta) => ({
          label: 'chunk',
          value: JSON.stringify(delta),
          tone: 'text' as const,
          delta,
        })),
        { label: 'toolCalls', value: 'calculator · provider-executed', tone: 'tool' },
        { label: 'finishReason', value: 'stop', tone: 'meta' },
      ],
    },
    example: 'examples/integrations/07-ai-sdk-adapter.ts',
    docsHref: '/docs/integrations/ai-sdk',
  },
];
