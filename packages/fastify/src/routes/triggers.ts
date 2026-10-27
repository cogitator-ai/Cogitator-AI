import type { FastifyError, FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  MAX_TRIGGER_BODY_BYTES,
  TRIGGER_BODY_TOO_LARGE,
  generateOpenAPISpec,
  handleTriggerRoute,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
  type StreamDocumentable,
  type TriggerRouteAnswer,
  type TriggersHost,
} from '@cogitator-ai/server-shared';
import { errorHandler } from '../hooks/error-handler.js';
import { sendRouteError } from './utils.js';

function send(reply: FastifyReply, answer: TriggerRouteAnswer): FastifyReply {
  return reply
    .status(answer.status)
    .headers(answer.headers ?? {})
    .type('application/json; charset=utf-8')
    .send(JSON.stringify(answer.body));
}

function firstValues(query: unknown): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  if (typeof query !== 'object' || query === null) return values;
  for (const [key, value] of Object.entries(query)) {
    const first: unknown = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') values[key] = first;
  }
  return values;
}

export interface TriggerRoutesOptions {
  host: TriggersHost;
}

/**
 * Experimental. `POST /triggers/:id/fire` and `/webhook`, registered beside the API routes so
 * none of their hooks run: no auth, anonymous policy or JSON body guard. A trigger checks its
 * caller itself, by token or signature over the raw body, which is read as a buffer whatever its
 * content type
 */
export const triggerRoutes: FastifyPluginAsync<TriggerRoutesOptions> = async (
  fastify,
  { host }
) => {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: MAX_TRIGGER_BODY_BYTES },
    (_request, body, done) => done(null, body)
  );
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 413) {
      send(reply, TRIGGER_BODY_TOO_LARGE);
      return;
    }
    errorHandler(error, request, reply);
  });

  for (const route of ['fire', 'webhook'] as const) {
    fastify.post<{ Params: { id: string } }>(
      `/triggers/:id/${route}`,
      { bodyLimit: MAX_TRIGGER_BODY_BYTES },
      async (request, reply) => {
        const rawBody = Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : '';
        return send(
          reply,
          await handleTriggerRoute(
            host,
            route,
            request.params.id,
            triggerRequestOf({
              method: request.method,
              headers: request.headers,
              rawBody,
              query: firstValues(request.query),
              ip: request.ip,
            })
          )
        );
      }
    );
  }
};

/** Experimental. `GET /inbox` and `PATCH /inbox/:id`, behind the plugin's auth */
export const inboxRoutes: FastifyPluginAsync<TriggerRoutesOptions> = async (fastify, { host }) => {
  fastify.get('/inbox', async (request, reply) => {
    try {
      return send(
        reply,
        await listInboxRoute(host, firstValues(request.query), request.cogitatorAuth?.userId)
      );
    } catch (error) {
      return sendRouteError(request, reply, error, 'inbox list error');
    }
  });
  fastify.patch<{ Params: { id: string } }>('/inbox/:id', async (request, reply) => {
    try {
      return send(
        reply,
        await patchInboxRoute(host, request.params.id, request.body, request.cogitatorAuth?.userId)
      );
    } catch (error) {
      return sendRouteError(request, reply, error, 'inbox update error');
    }
  });
};

const TRIGGER_PATHS = ['/triggers/{id}/fire', '/triggers/{id}/webhook', '/inbox', '/inbox/{id}'];

/** The names of the component schemas `value` refers to, at any depth */
function schemaRefs(value: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) schemaRefs(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string' && item.startsWith('#/components/schemas/')) {
        found.add(item.slice('#/components/schemas/'.length));
      } else {
        schemaRefs(item, found);
      }
    }
  }
  return found;
}

/**
 * Adds the trigger and inbox routes as every adapter documents them to the document
 * `@fastify/swagger` generated: their operations under `prefix`, the schemas they refer to, the
 * `triggerToken` scheme and the `triggers` tag. What the document already has of the same name
 * is kept, except the operations of these paths
 */
export function documentTriggers<T extends StreamDocumentable>(document: T, prefix: string): T {
  const shared = generateOpenAPISpec({ agents: {}, workflows: {}, swarms: {} }, { triggers: true });
  const base = prefix === '/' ? '' : prefix.replace(/\/$/, '');
  const paths: Record<string, unknown> = { ...(document.paths as Record<string, unknown>) };
  for (const path of TRIGGER_PATHS) {
    if (shared.paths[path]) paths[`${base}${path}`] = shared.paths[path];
  }

  const sharedSchemas = shared.components?.schemas ?? {};
  const wanted = schemaRefs(
    TRIGGER_PATHS.map((path) => shared.paths[path]),
    new Set()
  );
  for (const name of wanted) schemaRefs(sharedSchemas[name], wanted);

  const components = (document.components ?? {}) as {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  const schemas: Record<string, unknown> = {};
  for (const name of wanted) schemas[name] = sharedSchemas[name];

  const tags = ((document as { tags?: { name: string }[] }).tags ?? []).slice();
  for (const tag of shared.tags ?? []) {
    if (tag.name === 'triggers' && !tags.some((known) => known.name === tag.name)) tags.push(tag);
  }

  return {
    ...document,
    paths,
    tags,
    components: {
      ...components,
      schemas: { ...schemas, ...components.schemas },
      securitySchemes: {
        ...shared.components?.securitySchemes,
        ...components.securitySchemes,
      },
    },
  };
}
