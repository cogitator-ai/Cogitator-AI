import type { OpenAPIContext, SwaggerConfig, OpenAPISpec } from './openapi-types.js';
import { MAX_RUN_TIMEOUT_MS, NON_BLANK_PATTERN, RUN_INPUT_SCHEMA } from './validation.js';
import type { RunLimits } from './contract.js';
import { MAX_THREAD_PAGE_LIMIT } from './thread-page.js';
import { streamEventComponents } from './stream-schemas.js';

const THREAD_ID_SCHEMA = { type: 'string', minLength: 1, pattern: NON_BLANK_PATTERN } as const;

/** The body of an SSE route: each `data:` line is a StreamEvent, then `data: [DONE]` */
const SSE_CONTENT = {
  'text/event-stream': { schema: { $ref: '#/components/schemas/StreamEvent' } },
} as const;

const CONTEXT_SCHEMA = {
  type: 'object',
  description:
    'Values the run adds to the system prompt as data. Refused unless the server accepts the keys (`acceptContext`)',
} as const;

export function generateOpenAPISpec(ctx: OpenAPIContext, config: SwaggerConfig): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: {
      title: config.title || 'Cogitator API',
      description: config.description || 'AI Agent Runtime API',
      version: config.version || '1.0.0',
      contact: config.contact,
      license: config.license,
    },
    servers: config.servers || [{ url: '/', description: 'Default server' }],
    tags: [
      { name: 'health', description: 'Health check endpoints' },
      { name: 'agents', description: 'Agent execution endpoints' },
      { name: 'threads', description: 'Thread/conversation management' },
      { name: 'tools', description: 'Tool discovery' },
      { name: 'workflows', description: 'Workflow execution' },
      { name: 'swarms', description: 'Multi-agent swarm execution' },
    ],
    paths: {},
    components: {
      schemas: generateSchemas(config.limits),
      ...(config.auth && {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      }),
    },
    ...(config.auth && { security: [{ bearerAuth: [] }, {}] }),
  };

  spec.paths['/health'] = {
    get: {
      tags: ['health'],
      summary: 'Health check',
      responses: {
        200: {
          description: 'Service is healthy',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } },
          },
        },
      },
    },
  };

  spec.paths['/ready'] = {
    get: {
      tags: ['health'],
      summary: 'Readiness check',
      responses: {
        200: {
          description: 'Service is ready',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ReadinessResponse' } },
          },
        },
        503: {
          description: 'Service is not ready',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ReadinessResponse' } },
          },
        },
      },
    },
  };

  spec.paths['/agents'] = {
    get: {
      tags: ['agents'],
      summary: 'List all agents',
      responses: {
        200: {
          description: 'List of agents',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentListResponse' } },
          },
        },
      },
    },
  };

  const errorContent = {
    'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
  };
  const retryAfter = {
    'Retry-After': {
      description: 'Seconds to wait before trying again, when the provider said',
      schema: { type: 'integer', minimum: 1 },
    },
  };
  const threadForbidden = {
    description:
      'The thread belongs to another user (THREAD_ACCESS_DENIED), or the server keeps the caller from it (THREAD_FORBIDDEN)',
    content: errorContent,
  };
  const refusals = {
    400: {
      description: 'The body breaks the request schema (INVALID_INPUT)',
      content: errorContent,
    },
    ...(config.auth && {
      401: {
        description: 'The credentials were refused, or the caller has none (UNAUTHORIZED)',
        content: errorContent,
      },
    }),
    415: { description: 'The body is not JSON (UNSUPPORTED_MEDIA_TYPE)', content: errorContent },
  };
  const runFailures = {
    429: {
      description:
        'The provider limited the rate or the budget ran out (LLM_RATE_LIMITED, BUDGET_EXCEEDED)',
      headers: retryAfter,
      content: errorContent,
    },
    503: {
      description:
        'The provider or a circuit breaker is unavailable (LLM_UNAVAILABLE, CIRCUIT_OPEN)',
      headers: retryAfter,
      content: errorContent,
    },
    504: {
      description: 'The run ran out of time (RUN_TIMEOUT, LLM_TIMEOUT)',
      content: errorContent,
    },
  };

  for (const [name] of Object.entries(ctx.agents)) {
    spec.paths[`/agents/${name}/run`] = {
      post: {
        tags: ['agents'],
        summary: `Run agent: ${name}`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentRunRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Agent execution result',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AgentRunResponse' } },
            },
          },
          ...refusals,
          ...runFailures,
          403: threadForbidden,
          404: { description: 'Agent not found' },
        },
      },
    };

    spec.paths[`/agents/${name}/resume`] = {
      post: {
        tags: ['agents'],
        summary: `Resume a paused run of ${name} with approval decisions`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentResumeRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Agent execution result, or paused again',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AgentRunResponse' } },
            },
          },
          ...refusals,
          ...runFailures,
          403: threadForbidden,
          404: { description: 'Agent not found' },
          409: { description: 'The thread has no paused run (RUN_NOT_PAUSED)' },
        },
      },
    };

    spec.paths[`/agents/${name}/stream`] = {
      post: {
        tags: ['agents'],
        summary: `Stream agent: ${name}`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentRunRequest' } },
          },
        },
        responses: {
          200: {
            description:
              'SSE stream of protocol events. The start event (StreamStartEvent) names the thread of the run, and the finish event (StreamFinishEvent) repeats it with the usage and the outcome of the JSON run response',
            content: SSE_CONTENT,
          },
          ...refusals,
        },
      },
    };

    spec.paths[`/agents/${name}/resume/stream`] = {
      post: {
        tags: ['agents'],
        summary: `Resume a paused run of ${name} and stream the rest of it`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentResumeRequest' } },
          },
        },
        responses: {
          200: {
            description:
              'SSE stream of protocol events, as on /stream. A thread with no paused run ends the stream with an error event (RUN_NOT_PAUSED)',
            content: SSE_CONTENT,
          },
          ...refusals,
          403: threadForbidden,
          404: { description: 'Agent not found' },
        },
      },
    };
  }

  spec.paths['/threads/{id}'] = {
    get: {
      tags: ['threads'],
      summary: 'Get thread by ID, whole or a page at a time',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'limit',
          in: 'query',
          description:
            'Answer the newest `limit` messages of what is left and a `nextCursor`, without it the whole thread',
          schema: { type: 'integer', minimum: 1, maximum: MAX_THREAD_PAGE_LIMIT },
        },
        {
          name: 'cursor',
          in: 'query',
          description: 'The `nextCursor` of the page after the one to read',
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Thread data',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ThreadResponse' } },
          },
        },
        400: { description: 'limit or cursor is not valid (INVALID_INPUT)', content: errorContent },
        403: threadForbidden,
        503: { description: 'Memory not configured' },
      },
    },
    delete: {
      tags: ['threads'],
      summary: 'Delete thread',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 204: { description: 'Thread deleted' }, 403: threadForbidden },
    },
  };

  spec.paths['/threads/{id}/messages'] = {
    post: {
      tags: ['threads'],
      summary: 'Add message to thread',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/AddMessageRequest' } },
        },
      },
      responses: {
        201: { description: 'Message added; a missing thread is created for the caller' },
        ...refusals,
        403: threadForbidden,
      },
    },
  };

  spec.paths['/tools'] = {
    get: {
      tags: ['tools'],
      summary: 'List all tools',
      responses: {
        200: {
          description: 'List of tools',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ToolListResponse' } },
          },
        },
      },
    },
  };

  spec.paths['/workflows'] = {
    get: {
      tags: ['workflows'],
      summary: 'List all workflows',
      responses: {
        200: {
          description: 'List of workflows',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WorkflowListResponse' } },
          },
        },
      },
    },
  };

  for (const [name] of Object.entries(ctx.workflows)) {
    spec.paths[`/workflows/${name}/run`] = {
      post: {
        tags: ['workflows'],
        summary: `Run workflow: ${name}`,
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WorkflowRunRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Workflow result',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WorkflowRunResponse' } },
            },
          },
          ...refusals,
          ...runFailures,
        },
      },
    };

    spec.paths[`/workflows/${name}/stream`] = {
      post: {
        tags: ['workflows'],
        summary: `Stream workflow: ${name}`,
        responses: {
          200: {
            description: 'SSE stream of protocol events (StreamEvent), ending with `data: [DONE]`',
            content: SSE_CONTENT,
          },
        },
      },
    };
  }

  spec.paths['/swarms'] = {
    get: {
      tags: ['swarms'],
      summary: 'List all swarms',
      responses: {
        200: {
          description: 'List of swarms',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SwarmListResponse' } },
          },
        },
      },
    },
  };

  for (const [name] of Object.entries(ctx.swarms)) {
    spec.paths[`/swarms/${name}/run`] = {
      post: {
        tags: ['swarms'],
        summary: `Run swarm: ${name}`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SwarmRunRequest' } },
          },
        },
        responses: {
          200: {
            description: 'Swarm result',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SwarmRunResponse' } },
            },
          },
          ...refusals,
          ...runFailures,
          403: threadForbidden,
        },
      },
    };

    spec.paths[`/swarms/${name}/stream`] = {
      post: {
        tags: ['swarms'],
        summary: `Stream swarm: ${name}`,
        responses: {
          200: {
            description: 'SSE stream of protocol events (StreamEvent), ending with `data: [DONE]`',
            content: SSE_CONTENT,
          },
        },
      },
    };

    spec.paths[`/swarms/${name}/blackboard`] = {
      get: {
        tags: ['swarms'],
        summary: `Get blackboard: ${name}`,
        responses: {
          200: {
            description: 'Blackboard state',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BlackboardResponse' } },
            },
          },
        },
      },
    };
  }

  return spec;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * JSON safe to embed in an inline <script>: `<`, `>`, `&` and the line
 * separators JavaScript treats as newlines become unicode escapes, so text
 * from the spec (agent names, descriptions) cannot close the script tag.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** What {@link documentStreamEvents} needs of an OpenAPI document, typed loosely enough for any generator's */
export interface StreamDocumentable {
  paths?: object;
  components?: object;
}

type PathItem = Record<string, unknown>;
type StreamOperation = { responses?: Record<string, { description?: string }> };

/**
 * Adds the stream protocol to an OpenAPI document a framework generated from its own routes:
 * the StreamEvent components, and StreamEvent as the `text/event-stream` body of the `200` of
 * every POST route whose path ends in `/stream`. Components of the same name the document
 * already has are kept. `generateOpenAPISpec` documents its streams itself.
 *
 * @example
 * ```ts
 * await fastify.register(swagger, {
 *   openapi: { info },
 *   transformObject: ({ openapiObject }) => documentStreamEvents(openapiObject),
 * });
 * ```
 */
export function documentStreamEvents<T extends StreamDocumentable>(document: T): T {
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries((document.paths ?? {}) as Record<string, unknown>)) {
    const post = (item as PathItem | undefined)?.post as StreamOperation | undefined;
    if (!path.endsWith('/stream') || !post) {
      paths[path] = item;
      continue;
    }
    paths[path] = {
      ...(item as PathItem),
      post: {
        ...post,
        responses: {
          ...post.responses,
          200: {
            description:
              post.responses?.['200']?.description ??
              'SSE stream of protocol events (StreamEvent), ending with `data: [DONE]`',
            content: SSE_CONTENT,
          },
        },
      },
    };
  }
  const components = (document.components ?? {}) as { schemas?: Record<string, unknown> };
  return {
    ...document,
    paths,
    components: { ...components, schemas: { ...streamEventComponents(), ...components.schemas } },
  };
}

export function generateSwaggerHTML(spec: OpenAPISpec): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(spec.info.title)} - API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        spec: ${scriptJson(spec)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>`;
}

const RUN_OUTCOME_PROPERTIES = {
  status: {
    type: 'string',
    enum: ['completed', 'paused'],
    description: '`paused` when tool calls wait for approval; resume with the thread id to go on',
  },
  pendingApprovals: {
    type: 'array',
    items: { $ref: '#/components/schemas/PendingApproval' },
    description: 'The tool calls a paused run waits on',
  },
  structured: { description: "The answer parsed against the agent's responseFormat" },
  structuredError: {
    type: 'string',
    description: "Why the answer does not match the agent's responseFormat",
  },
  truncated: {
    type: 'boolean',
    enum: [true],
    description: 'The answer stopped at the output token limit and may be cut off',
  },
  blocked: {
    type: 'string',
    enum: ['content_filter', 'refusal'],
    description: 'The provider withheld the answer',
  },
  iterationLimitReached: {
    type: 'boolean',
    enum: [true],
    description: "Tool calls used up the agent's maxIterations before the model answered",
  },
} as const;

function generateSchemas(limits: RunLimits | undefined): Record<string, unknown> {
  return {
    ...streamEventComponents(),
    HealthResponse: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
        uptime: { type: 'number' },
        timestamp: { type: 'number' },
      },
    },
    ReadinessResponse: {
      type: 'object',
      required: ['status', 'checks'],
      properties: {
        status: { type: 'string', enum: ['ok', 'error'] },
        checks: {
          type: 'object',
          additionalProperties: { type: 'string', enum: ['ok', 'error', 'unchecked'] },
        },
      },
    },
    AgentListResponse: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              tools: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    AgentRunRequest: {
      type: 'object',
      required: ['input'],
      properties: {
        input: { ...RUN_INPUT_SCHEMA },
        context: CONTEXT_SCHEMA,
        threadId: THREAD_ID_SCHEMA,
      },
    },
    ToolApprovalDecision: {
      type: 'object',
      required: ['approved'],
      properties: { approved: { type: 'boolean' }, reason: { type: 'string' } },
    },
    AgentResumeRequest: {
      type: 'object',
      required: ['threadId'],
      properties: {
        threadId: THREAD_ID_SCHEMA,
        decisions: {
          type: 'object',
          additionalProperties: { $ref: '#/components/schemas/ToolApprovalDecision' },
        },
        defaultDecision: { $ref: '#/components/schemas/ToolApprovalDecision' },
      },
    },
    AgentToolCall: {
      type: 'object',
      required: ['id', 'name', 'arguments'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        arguments: { type: 'object' },
      },
    },
    AgentRunResponse: {
      type: 'object',
      description:
        'The answer of a run. It never carries the system prompt, the history, trace spans or the checkpoint of a paused run',
      required: ['output', 'threadId', 'usage', 'toolCalls', 'status', 'traceId'],
      properties: {
        output: { type: 'string' },
        threadId: { type: 'string' },
        usage: { $ref: '#/components/schemas/RunUsage' },
        toolCalls: { type: 'array', items: { $ref: '#/components/schemas/AgentToolCall' } },
        reasoning: { type: 'string' },
        ...RUN_OUTCOME_PROPERTIES,
        traceId: { type: 'string', description: 'Links the answer to the server traces' },
      },
    },
    ThreadResponse: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        messages: { type: 'array', description: 'The messages of the page, oldest first' },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
        nextCursor: {
          type: 'string',
          description: 'Pass as `cursor` to read the page before this one, absent at the start',
        },
      },
    },
    AddMessageRequest: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: {
          type: 'string',
          enum: ['user', 'assistant', 'system'],
          description:
            '`system` is refused unless the server accepts it (`threadMessageRoles`), since the model reads it as operator instructions',
        },
        content: { type: 'string', minLength: 1, pattern: NON_BLANK_PATTERN },
        metadata: { type: 'object' },
      },
    },
    ToolListResponse: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              parameters: { type: 'object' },
            },
          },
        },
      },
    },
    WorkflowListResponse: {
      type: 'object',
      properties: {
        workflows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              entryPoint: { type: 'string' },
              nodes: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    WorkflowRunRequest: {
      type: 'object',
      properties: {
        input: { type: 'object' },
        options: {
          type: 'object',
          properties: {
            maxConcurrency: limitedInteger(limits?.workflowMaxConcurrency),
            maxIterations: limitedInteger(limits?.workflowMaxIterations),
            checkpoint: {
              type: 'boolean',
              enum: [false],
              description: 'Only `false`: the server keeps no checkpoint store',
            },
          },
        },
      },
    },
    WorkflowRunResponse: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        workflowName: { type: 'string' },
        state: { type: 'object' },
        duration: { type: 'number' },
        nodeResults: { type: 'object' },
      },
    },
    SwarmListResponse: {
      type: 'object',
      properties: {
        swarms: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              strategy: { type: 'string' },
              agents: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    SwarmRunRequest: {
      type: 'object',
      required: ['input'],
      properties: {
        input: { ...RUN_INPUT_SCHEMA },
        context: CONTEXT_SCHEMA,
        threadId: THREAD_ID_SCHEMA,
        timeout: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_RUN_TIMEOUT_MS,
          ...(limits?.swarmTimeout !== undefined && {
            default: limits.swarmTimeout,
            description: `Held to ${limits.swarmTimeout} ms, the server's limit, which is also the default`,
          }),
        },
      },
    },
    SwarmRunResponse: {
      type: 'object',
      properties: {
        swarmId: { type: 'string' },
        swarmName: { type: 'string' },
        strategy: { type: 'string' },
        output: {},
        agentResults: { type: 'object' },
        usage: {
          type: 'object',
          properties: {
            totalTokens: { type: 'number' },
            totalCost: { type: 'number' },
            elapsedTime: { type: 'number' },
          },
        },
      },
    },
    BlackboardResponse: {
      type: 'object',
      properties: {
        sections: { type: 'object' },
      },
    },
    ErrorResponse: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            code: { type: 'string' },
          },
        },
      },
    },
  };
}

/**
 * An integer field the operator may cap: the cap is not a maximum the request is refused
 * over, the server holds a larger value to it, so the spec says so and gives it as the default
 */
function limitedInteger(cap: number | undefined): Record<string, unknown> {
  return {
    type: 'integer',
    minimum: 1,
    ...(cap !== undefined && {
      default: cap,
      description: `Held to ${cap}, the server's limit, which is also the default`,
    }),
  };
}
