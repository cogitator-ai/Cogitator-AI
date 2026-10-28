import type { OpenAPIContext, SwaggerConfig, OpenAPISpec } from './openapi-types.js';
import {
  MAX_RUN_TIMEOUT_MS,
  MULTITASK_STRATEGIES,
  NON_BLANK_PATTERN,
  RUN_INPUT_SCHEMA,
} from './validation.js';
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
  const checkpointNotFound = {
    description:
      'No workflow of this name (NOT_FOUND), or no checkpoint of it that belongs to the caller (CHECKPOINT_NOT_FOUND)',
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
  const busyThread = {
    description:
      "The thread has a run going on and the run's `multitaskStrategy` is `reject` (THREAD_BUSY), or a newer run on the thread with `interrupt` or `rollback` stopped this one (RUN_INTERRUPTED)",
    content: errorContent,
  };
  const interruptExpired = {
    description: 'An answer in `responses` came after its interrupt expired (INTERRUPT_EXPIRED)',
    content: errorContent,
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

  const resumable = config.resumableStreams === true;
  const reconnect = resumable
    ? {
        parameters: [
          {
            name: 'Last-Event-ID',
            in: 'header',
            required: false,
            description:
              'Reconnect to the stream of a run instead of starting one: the `id` of the last event the client got (`<streamId>:<seq>`). The answer replays the events after it, then follows the run to its end. The body is not read',
            schema: { type: 'string' },
          },
          {
            name: 'lastEventId',
            in: 'query',
            required: false,
            description:
              'The same as the `Last-Event-ID` header, for clients that cannot set it. Prefer the header: a query parameter ends up in URLs and access logs',
            schema: { type: 'string' },
          },
        ],
      }
    : {};
  const streamIds = resumable
    ? ' Every event carries an `id` (`<streamId>:<seq>`). A client that loses the stream reconnects with it as `Last-Event-ID`, while the run goes on without it. A reconnect after events that are no longer kept gets one error event with STREAM_RESUME_GAP: fetch the thread to catch up. A run stopped by its caller ends with STREAM_CANCELLED, one stopped with nobody following it or by a shutdown with STREAM_ABORTED'
    : '';
  const streamNotFound = resumable
    ? ", or the stream a reconnect names is unknown, expired or not the caller's (STREAM_NOT_FOUND)"
    : '';
  const streamLimit = resumable
    ? {
        503: {
          description:
            'The server keeps as many streams as it may, all still going (STREAM_LIMIT_REACHED)',
          content: errorContent,
        },
      }
    : {};
  const streamRefusals = resumable
    ? {
        400: {
          description:
            'The body breaks the request schema, or `Last-Event-ID` is not an event id (INVALID_INPUT)',
          content: errorContent,
        },
      }
    : {};

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
          409: busyThread,
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
          409: {
            description:
              "The thread has no paused run (RUN_NOT_PAUSED), or the resumed run met another run of the thread: the server's `multitaskStrategy` is `reject` (THREAD_BUSY), or a newer run stopped it (RUN_INTERRUPTED)",
            content: errorContent,
          },
          410: interruptExpired,
        },
      },
    };

    spec.paths[`/agents/${name}/stream`] = {
      post: {
        tags: ['agents'],
        summary: `Stream agent: ${name}`,
        ...reconnect,
        requestBody: {
          required: !resumable,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentRunRequest' } },
          },
        },
        responses: {
          200: {
            description: `SSE stream of protocol events. The start event (StreamStartEvent) names the thread of the run, and the finish event (StreamFinishEvent) repeats it with the usage and the outcome of the JSON run response. The stream is open before the run meets the other runs of its thread, so THREAD_BUSY and RUN_INTERRUPTED end it with an error event carrying that code, where /run answers 409.${streamIds}`,
            content: SSE_CONTENT,
          },
          ...refusals,
          ...streamRefusals,
          ...streamLimit,
          403: threadForbidden,
          ...(resumable && {
            404: { description: `Agent not found${streamNotFound}`, content: errorContent },
          }),
        },
      },
    };

    spec.paths[`/agents/${name}/resume/stream`] = {
      post: {
        tags: ['agents'],
        summary: `Resume a paused run of ${name} and stream the rest of it`,
        ...reconnect,
        requestBody: {
          required: !resumable,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AgentResumeRequest' } },
          },
        },
        responses: {
          200: {
            description: `SSE stream of protocol events, as on /stream. A thread with no paused run, a run of the thread in the way and an answer after its interrupt expired end the stream with an error event carrying the code /resume answers with (RUN_NOT_PAUSED, THREAD_BUSY, RUN_INTERRUPTED, INTERRUPT_EXPIRED).${streamIds}`,
            content: SSE_CONTENT,
          },
          ...refusals,
          ...streamRefusals,
          ...streamLimit,
          403: threadForbidden,
          404: {
            description: `Agent not found${streamNotFound}`,
            ...(resumable && { content: errorContent }),
          },
        },
      },
    };

    spec.paths[`/agents/${name}/agui`] = {
      post: {
        tags: ['agents'],
        summary: `Run or resume ${name} for an AG-UI client`,
        description:
          "Takes an AG-UI 1.0 RunAgentInput and streams the run as AG-UI events, for CopilotKit or an @ag-ui/client HttpAgent. The AG-UI thread is the run's memory thread: the last message, which must be the user's, starts a new turn, and `resume` entries answer every interrupt of the paused run at once. `state` is the run's state, `context` its brief",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'An AG-UI 1.0 RunAgentInput',
                required: ['threadId', 'runId', 'messages'],
                properties: {
                  threadId: { type: 'string' },
                  runId: { type: 'string' },
                  messages: { type: 'array', items: { type: 'object' } },
                  state: {},
                  context: { type: 'array', items: { type: 'object' } },
                  resume: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description:
              'SSE stream of AG-UI events: RUN_STARTED first, RUN_FINISHED (outcome success, interrupt or cancelled) or RUN_ERROR last, no [DONE]',
            content: SSE_CONTENT,
          },
          ...refusals,
          400: {
            description: 'Not a RunAgentInput, or no user message last (INVALID_INPUT)',
            content: errorContent,
          },
          403: threadForbidden,
          404: { description: 'Agent not found' },
        },
      },
    };

    if (resumable) {
      spec.paths[`/agents/${name}/stream/{streamId}`] = {
        delete: {
          tags: ['agents'],
          summary: `Cancel the run of a stream of ${name}`,
          description:
            'Stops the run of a resumable stream, on whatever process runs it: its stream ends with an error event STREAM_CANCELLED. Only the caller who started the stream may cancel its run. A stream that already finished is left as it is',
          parameters: [
            {
              name: 'streamId',
              in: 'path',
              required: true,
              description: 'The stream id, the part of an event id before the last `:`',
              schema: { type: 'string' },
            },
          ],
          responses: {
            204: { description: 'The run was cancelled, or had already finished' },
            400: {
              description: 'The stream id is not valid (INVALID_INPUT)',
              content: errorContent,
            },
            403: threadForbidden,
            404: {
              description:
                "Agent not found, or the stream is unknown, expired or not the caller's (STREAM_NOT_FOUND)",
              content: errorContent,
            },
          },
        },
      };
    }
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
            description:
              'SSE stream of protocol events (StreamEvent), ending with `data: [DONE]`. A failed run sends a `workflow_failed` event, with the `checkpointId` to resume from when the run saved one, right before its `error` event',
            content: SSE_CONTENT,
          },
        },
      },
    };

    spec.paths[`/workflows/${name}/resume`] = {
      post: {
        tags: ['workflows'],
        summary: `Resume workflow ${name} from a checkpoint`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WorkflowResumeRequest' } },
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
          404: checkpointNotFound,
        },
      },
    };

    spec.paths[`/workflows/${name}/resume/stream`] = {
      post: {
        tags: ['workflows'],
        summary: `Resume workflow ${name} from a checkpoint and stream the rest of it`,
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WorkflowResumeRequest' } },
          },
        },
        responses: {
          200: {
            description: 'SSE stream of protocol events, as on /stream, `workflow_failed` included',
            content: SSE_CONTENT,
          },
          ...refusals,
          404: checkpointNotFound,
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

  if (config.triggers) {
    (spec.tags ??= []).push({
      name: 'triggers',
      description: 'Routines started by API calls and webhooks, and the inbox of their results',
    });
    const id = {
      name: 'id',
      in: 'path',
      required: true,
      description: 'The trigger, `<routineId>.<triggerId>`',
      schema: { type: 'string' },
    };
    const fired = {
      description: 'The firing was taken: a run started, was queued or skipped (see `status`)',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/TriggerFireResult' } },
      },
    };
    const duplicate = {
      description:
        'The event was delivered before (`status: duplicate`), or Slack asked to verify the URL',
      content: { 'application/json': { schema: { type: 'object' } } },
    };
    const triggerRefusals = {
      401: {
        description: 'The token or signature is not valid (UNAUTHORIZED)',
        content: errorContent,
      },
      404: {
        description: 'No such trigger, or not one for this route (NOT_FOUND)',
        content: errorContent,
      },
      409: { description: 'The trigger is paused (TRIGGER_DISABLED)', content: errorContent },
      413: { description: 'The body is over 10 MiB (PAYLOAD_TOO_LARGE)', content: errorContent },
      429: {
        description: 'The trigger took `maxPerHour` events in the last hour (RATE_LIMITED)',
        headers: retryAfter,
        content: errorContent,
      },
    };
    spec.paths['/triggers/{id}/fire'] = {
      post: {
        tags: ['triggers'],
        summary: 'Fire an API trigger',
        description:
          "Starts a session of the routine with its prompt as the task and `text` as untrusted data. Authenticated by the trigger's own bearer token, not by the server's auth. `Idempotency-Key` makes repeats start one run",
        security: [{ triggerToken: [] }],
        parameters: [
          id,
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { text: { type: 'string', maxLength: 65536 } },
              },
            },
          },
        },
        responses: {
          200: duplicate,
          202: fired,
          400: {
            description: 'The body is not `{ text }` (VALIDATION_ERROR)',
            content: errorContent,
          },
          ...triggerRefusals,
        },
      },
    };
    spec.paths['/triggers/{id}/webhook'] = {
      post: {
        tags: ['triggers'],
        summary: 'Deliver a webhook to a trigger',
        description:
          'A generic webhook signed with HMAC over the raw body, a GitHub delivery (`X-Hub-Signature-256`), inbound mail of Mailgun, Postmark or SendGrid, or a Slack Events API callback. The body is read as it came, any content type. The payload reaches the routine as untrusted data',
        security: [],
        parameters: [id],
        requestBody: { required: true, content: { '*/*': { schema: {} } } },
        responses: { 200: duplicate, 202: fired, ...triggerRefusals },
      },
    };
    spec.paths['/inbox'] = {
      get: {
        tags: ['triggers'],
        summary: "The caller's inbox",
        description:
          "Results, failures, approvals and questions of routines, newest first: the items of the caller's user id. A caller without one gets 401 unless the server is set to anonymous: 'allow', then the items of no user",
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            description: 'unread, read, archived, comma-separated',
            schema: { type: 'string' },
          },
          {
            name: 'kind',
            in: 'query',
            required: false,
            description: 'result, approval, question, failure, comma-separated',
            schema: { type: 'string' },
          },
          { name: 'routineId', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          {
            name: 'before',
            in: 'query',
            required: false,
            description:
              'Only items created before this time (ms), the `nextBefore` of the page before',
            schema: { type: 'integer' },
          },
          {
            name: 'beforeId',
            in: 'query',
            required: false,
            description:
              'With `before`: also the items created at that time whose id sorts before this one, the `nextBeforeId` of the page before',
            schema: { type: 'string' },
          },
        ],
        responses: {
          200: {
            description: 'A page of items',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/InboxItem' } },
                    nextBefore: { type: 'integer' },
                    nextBeforeId: { type: 'string' },
                  },
                },
              },
            },
          },
          400: {
            description: 'A query parameter is not valid (INVALID_INPUT)',
            content: errorContent,
          },
          401: {
            description:
              "A caller without a user id where the server is not set to anonymous: 'allow' (UNAUTHORIZED)",
            content: errorContent,
          },
        },
      },
    };
    spec.paths['/inbox/{id}'] = {
      patch: {
        tags: ['triggers'],
        summary: 'Mark an inbox item read, unread or archived',
        description:
          'Changes the status only: whether an approval or question was answered (`answeredAt`) stays as it is',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: { status: { type: 'string', enum: ['unread', 'read', 'archived'] } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'The item after the change',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InboxItem' } } },
          },
          400: {
            description: 'The body is not `{ status }` (INVALID_INPUT)',
            content: errorContent,
          },
          401: {
            description:
              "A caller without a user id where the server is not set to anonymous: 'allow' (UNAUTHORIZED)",
            content: errorContent,
          },
          404: { description: "No such item of the caller's (NOT_FOUND)", content: errorContent },
        },
      },
    };
    const components = (spec.components ??= {});
    const schemas = (components.schemas ??= {});
    schemas.TriggerFireResult = {
      type: 'object',
      required: ['type', 'status', 'eventId', 'triggerId'],
      properties: {
        type: { type: 'string', enum: ['routine_fire'] },
        status: { type: 'string', enum: ['started', 'queued', 'skipped', 'duplicate'] },
        eventId: { type: 'string' },
        routineId: { type: 'string' },
        triggerId: { type: 'string' },
        runId: { type: 'string' },
        threadId: { type: 'string' },
        reason: { type: 'string' },
      },
    };
    schemas.InboxItem = {
      type: 'object',
      required: ['id', 'kind', 'title', 'summary', 'status', 'createdAt'],
      properties: {
        id: { type: 'string' },
        kind: { type: 'string', enum: ['result', 'approval', 'question', 'failure'] },
        title: { type: 'string' },
        summary: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: ['unread', 'read', 'archived'] },
        createdAt: { type: 'integer' },
        updatedAt: { type: 'integer' },
        answeredAt: {
          type: 'integer',
          description: 'When a person answered the approval or question, set once',
        },
        routineId: { type: 'string' },
        triggerId: { type: 'string' },
        triggerEventId: { type: 'string' },
        source: { type: 'string' },
        runId: { type: 'string' },
        threadId: { type: 'string' },
        workflowRunId: { type: 'string' },
        approvalId: { type: 'string' },
        actions: { type: 'array', items: { type: 'object' } },
        metadata: { type: 'object' },
      },
    };
    components.securitySchemes = {
      ...components.securitySchemes,
      triggerToken: { type: 'http', scheme: 'bearer', description: "The API trigger's own token" },
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

const MULTITASK_STRATEGY_SCHEMA = {
  type: 'string',
  enum: [...MULTITASK_STRATEGIES],
  description:
    'What the run does when its thread has a run going on: wait (`enqueue`), fail with THREAD_BUSY (`reject`), stop that run, which fails with RUN_INTERRUPTED (`interrupt`), or stop it and branch from where it started (`rollback`). The run route answers both codes with 409, a stream sends them as an `error` event with that code',
};

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
  interrupts: {
    type: 'array',
    items: { $ref: '#/components/schemas/PendingInterrupt' },
    description:
      "The questions a paused run's tools asked: answer them by id in `responses` when resuming",
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
  stopped: {
    type: 'object',
    properties: { reason: { type: 'string' }, middleware: { type: 'string' } },
    required: ['reason', 'middleware'],
    description: 'A hook or middleware ended the run before its next model call',
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
        multitaskStrategy: MULTITASK_STRATEGY_SCHEMA,
      },
    },
    ToolApprovalDecision: {
      type: 'object',
      required: ['approved'],
      properties: {
        approved: { type: 'boolean' },
        reason: { type: 'string', description: 'Why the call was refused, for the model' },
        updatedArguments: {
          type: 'object',
          additionalProperties: true,
          description:
            "The arguments an approved call runs with instead, checked against the tool's schema and the rules again",
        },
        remember: {
          description:
            'Approve calls like this one from now on: `true` saves the `suggestedRule` of the approval where the server saves rules (`local` settings by default), an object names the rule (which must cover the call) and the layer (one the server allows, `session` and `local` by default)',
          oneOf: [
            { type: 'boolean' },
            {
              type: 'object',
              properties: {
                rule: { type: 'string' },
                layer: { type: 'string', enum: ['session', 'local', 'project', 'user'] },
              },
            },
          ],
        },
      },
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
        responses: {
          type: 'object',
          additionalProperties: true,
          description:
            "Answers to the run's interrupts by interrupt id, each checked against its responseSchema",
        },
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
              description:
                'Save checkpoints of the run to resume it from. Accepted when the server has a checkpoint store (`workflowCheckpoints`), refused otherwise',
            },
          },
        },
      },
    },
    WorkflowResumeRequest: {
      type: 'object',
      required: ['checkpointId'],
      properties: {
        checkpointId: {
          type: 'string',
          minLength: 1,
          pattern: NON_BLANK_PATTERN,
          description: 'A checkpoint of this workflow that belongs to the caller',
        },
        options: {
          type: 'object',
          properties: {
            maxConcurrency: limitedInteger(limits?.workflowMaxConcurrency),
            maxIterations: limitedInteger(limits?.workflowMaxIterations),
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
        checkpointId: {
          type: 'string',
          description:
            'The last checkpoint of a run with `options.checkpoint` or of a resume: pass it to /resume',
        },
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
            checkpointId: {
              type: 'string',
              description:
                'The last checkpoint a failed workflow run saved: pass it to /workflows/{name}/resume',
            },
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
