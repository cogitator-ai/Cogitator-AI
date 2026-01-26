import type { RouteContext, SwaggerConfig, OpenAPISpec } from '../types.js';

export function generateOpenAPISpec(ctx: RouteContext, config: SwaggerConfig): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: {
      title: config.title || 'Cogitator API',
      description: config.description || 'AI Agent Runtime API',
      version: config.version || '1.0.0',
      contact: config.contact,
      license: config.license,
    },
    servers: config.servers || [{ url: ctx.config.basePath, description: 'Default server' }],
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
      schemas: generateSchemas(),
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
  };

  spec.paths['/health'] = {
    get: {
      tags: ['health'],
      summary: 'Health check',
      responses: {
        200: {
          description: 'Service is healthy',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/HealthResponse' },
            },
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
        200: { description: 'Service is ready' },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentListResponse' },
            },
          },
        },
      },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentRunRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Agent execution result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AgentRunResponse' },
              },
            },
          },
          404: { description: 'Agent not found' },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/AgentRunRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'SSE stream',
            content: { 'text/event-stream': {} },
          },
        },
      },
    };
  }

  spec.paths['/threads/{id}'] = {
    get: {
      tags: ['threads'],
      summary: 'Get thread by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Thread data',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ThreadResponse' },
            },
          },
        },
        503: { description: 'Memory not configured' },
      },
    },
    delete: {
      tags: ['threads'],
      summary: 'Delete thread',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        204: { description: 'Thread deleted' },
      },
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
          'application/json': {
            schema: { $ref: '#/components/schemas/AddMessageRequest' },
          },
        },
      },
      responses: {
        201: { description: 'Message added' },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/ToolListResponse' },
            },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/WorkflowListResponse' },
            },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/WorkflowRunRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Workflow result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WorkflowRunResponse' },
              },
            },
          },
        },
      },
    };

    spec.paths[`/workflows/${name}/stream`] = {
      post: {
        tags: ['workflows'],
        summary: `Stream workflow: ${name}`,
        responses: {
          200: {
            description: 'SSE stream',
            content: { 'text/event-stream': {} },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/SwarmListResponse' },
            },
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
            'application/json': {
              schema: { $ref: '#/components/schemas/SwarmRunRequest' },
            },
          },
        },
        responses: {
          200: {
            description: 'Swarm result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SwarmRunResponse' },
              },
            },
          },
        },
      },
    };

    spec.paths[`/swarms/${name}/stream`] = {
      post: {
        tags: ['swarms'],
        summary: `Stream swarm: ${name}`,
        responses: {
          200: {
            description: 'SSE stream',
            content: { 'text/event-stream': {} },
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
              'application/json': {
                schema: { $ref: '#/components/schemas/BlackboardResponse' },
              },
            },
          },
        },
      },
    };
  }

  return spec;
}

function generateSchemas(): Record<string, unknown> {
  return {
    HealthResponse: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
        uptime: { type: 'number' },
        timestamp: { type: 'number' },
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
        input: { type: 'string' },
        context: { type: 'object' },
        threadId: { type: 'string' },
      },
    },
    AgentRunResponse: {
      type: 'object',
      properties: {
        output: { type: 'string' },
        threadId: { type: 'string' },
        usage: {
          type: 'object',
          properties: {
            inputTokens: { type: 'number' },
            outputTokens: { type: 'number' },
            totalTokens: { type: 'number' },
          },
        },
        toolCalls: { type: 'array' },
      },
    },
    ThreadResponse: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        messages: { type: 'array' },
        createdAt: { type: 'number' },
        updatedAt: { type: 'number' },
      },
    },
    AddMessageRequest: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: { type: 'string', enum: ['user', 'assistant', 'system'] },
        content: { type: 'string' },
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
        options: { type: 'object' },
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
        input: { type: 'string' },
        context: { type: 'object' },
        threadId: { type: 'string' },
        timeout: { type: 'number' },
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
