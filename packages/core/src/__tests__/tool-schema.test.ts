import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolSchema } from '@cogitator-ai/types';

const mockResponsesCreate = vi.fn();
const mockChatCreate = vi.fn();
const mockAnthropicCreate = vi.fn();
const mockBedrockSend = vi.fn();
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('openai', () => {
  class MockOpenAI {
    responses = { create: mockResponsesCreate };
    chat = { completions: { create: mockChatCreate } };
    baseURL = 'https://api.openai.com/v1';
  }
  return { default: MockOpenAI };
});

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {}
  class MockAnthropic {
    messages = { create: mockAnthropicCreate };
    static APIError = APIError;
  }
  return { default: MockAnthropic };
});

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  class BedrockRuntimeClient {
    send = mockBedrockSend;
  }
  return { BedrockRuntimeClient, ConverseCommand: Command, ConverseStreamCommand: Command };
});

const { tool, toolToSchema } = await import('../tool');
const { toToolParameters } = await import('../tool-schema');
const { ToolRegistry } = await import('../registry');
const { OpenAIBackend } = await import('../llm/openai');
const { AnthropicBackend } = await import('../llm/anthropic');
const { BedrockBackend } = await import('../llm/bedrock');
const { GoogleBackend } = await import('../llm/google');
const { OllamaBackend } = await import('../llm/ollama');

interface TreeNode {
  name: string;
  children: TreeNode[];
}

const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({ name: z.string(), children: z.array(TreeNodeSchema) })
);

const treeTool = tool({
  name: 'save_tree',
  description: 'Save a tree',
  parameters: z.object({ tree: TreeNodeSchema, label: z.string() }),
  execute: async () => 'saved',
});

/** Every `$ref` in a schema, and whether each one points at something inside the schema. */
function danglingRefs(schema: unknown): string[] {
  const refs: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.$ref === 'string') refs.push(record.$ref);
    Object.values(record).forEach(visit);
  };
  visit(schema);
  return refs.filter((ref) => {
    if (!ref.startsWith('#')) return true;
    let target: unknown = schema;
    for (const segment of ref.slice(1).split('/').filter(Boolean)) {
      if (typeof target !== 'object' || target === null) return true;
      target = (target as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return target === undefined;
  });
}

describe('tool parameter schemas', () => {
  it('keeps the definitions a recursive schema refers to', () => {
    const { parameters } = toolToSchema(treeTool);

    expect(parameters.$defs).toBeDefined();
    expect(danglingRefs(parameters)).toEqual([]);
    expect(parameters.properties.tree).toEqual({ $ref: expect.stringMatching(/^#\/\$defs\//) });
    expect(parameters.required).toEqual(['tree', 'label']);
  });

  it('inlines refs to definitions that are not recursive', () => {
    const Address = z.object({ city: z.string() }).meta({ id: 'Address' });
    const shipping = tool({
      name: 'ship',
      description: 'Ship',
      parameters: z.object({ from: Address, to: Address.describe('Destination') }),
      execute: async () => 'ok',
    });

    const { parameters } = toolToSchema(shipping);

    expect(parameters.$defs).toBeUndefined();
    expect(parameters.properties.from).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
    expect(parameters.properties.to).toEqual({
      description: 'Destination',
      allOf: [{ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }],
    });
  });

  it('gathers definitions and $defs of a JSON schema, keeping only recursive ones', () => {
    const parameters = toToolParameters({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        order: { $ref: '#/definitions/Order' },
        category: { $ref: '#/$defs/Category' },
      },
      required: ['order'],
      additionalProperties: false,
      definitions: {
        Order: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
      },
      $defs: {
        Category: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parent: { anyOf: [{ $ref: '#/$defs/Category' }, { type: 'null' }] },
          },
        },
      },
    });

    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters).not.toHaveProperty('definitions');
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.order).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    });
    expect(Object.keys(parameters.$defs ?? {})).toEqual(['Category']);
    expect(danglingRefs(parameters)).toEqual([]);
  });

  it('sends the schema a tool reports through toJSON, made self-contained', () => {
    const jsonTool: Tool = {
      name: 'mcp_tool',
      description: 'From an MCP server',
      parameters: z.object({}),
      execute: async () => null,
      toJSON: (): ToolSchema => ({
        name: 'mcp_tool',
        description: 'From an MCP server',
        parameters: {
          type: 'object',
          properties: { order: { $ref: '#/$defs/Order' } },
          $defs: { Order: { type: 'object', properties: { id: { type: 'integer' } } } },
        },
      }),
    };
    const registry = new ToolRegistry();
    registry.register(jsonTool);

    const [schema] = registry.getSchemas();

    expect(schema.parameters.properties.order).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' } },
    });
  });
});

describe('recursive tool schemas in every provider format', () => {
  const tools = (() => {
    const registry = new ToolRegistry();
    registry.register(treeTool);
    return registry.getSchemas();
  })();
  const request = { messages: [{ role: 'user' as const, content: 'Save it' }], tools };

  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockChatCreate.mockReset();
    mockAnthropicCreate.mockReset();
    mockBedrockSend.mockReset();
    mockFetch.mockReset();
  });

  it('OpenAI Responses', async () => {
    mockResponsesCreate.mockResolvedValueOnce({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-6.1-sol',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    await new OpenAIBackend({ apiKey: 'sk-test' }).chat({ model: 'gpt-6.1-sol', ...request });

    const sent = mockResponsesCreate.mock.calls[0][0] as { tools: { parameters: unknown }[] };
    expect(sent.tools[0].parameters).toHaveProperty('$defs');
    expect(danglingRefs(sent.tools[0].parameters)).toEqual([]);
  });

  it('OpenAI Chat Completions', async () => {
    mockChatCreate.mockResolvedValueOnce({
      id: 'chat_1',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    await new OpenAIBackend({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' }).chat({
      model: 'some/model',
      ...request,
    });

    const sent = mockChatCreate.mock.calls[0][0] as {
      tools: { function: { parameters: unknown } }[];
    };
    expect(sent.tools[0].function.parameters).toHaveProperty('$defs');
    expect(danglingRefs(sent.tools[0].function.parameters)).toEqual([]);
  });

  it('Anthropic', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await new AnthropicBackend({ apiKey: 'k' }).chat({ model: 'claude-sonnet-4-5', ...request });

    const sent = mockAnthropicCreate.mock.calls[0][0] as { tools: { input_schema: unknown }[] };
    expect(sent.tools[0].input_schema).toHaveProperty('$defs');
    expect(danglingRefs(sent.tools[0].input_schema)).toEqual([]);
  });

  it('Bedrock', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await new BedrockBackend({
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    }).chat({ model: 'anthropic.claude-sonnet-4-5', ...request });

    const command = mockBedrockSend.mock.calls[0][0] as {
      input: { toolConfig: { tools: { toolSpec: { inputSchema: { json: unknown } } }[] } };
    };
    const schema = command.input.toolConfig.tools[0].toolSpec.inputSchema.json;
    expect(schema).toHaveProperty('$defs');
    expect(danglingRefs(schema)).toEqual([]);
  });

  it('Ollama', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model: 'llama3.2',
        message: { role: 'assistant', content: 'ok' },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    });
    await new OllamaBackend({ baseUrl: 'http://localhost:11434' }).chat({
      model: 'llama3.2',
      ...request,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      tools: { function: { parameters: unknown } }[];
    };
    expect(danglingRefs(body.tools[0].function.parameters)).toEqual([]);
    expect(body.tools[0].function.parameters).toHaveProperty('$defs');
  });

  it('Gemini, through parametersJsonSchema', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    });
    await new GoogleBackend({ apiKey: 'k' }).chat({ model: 'gemini-2.5-flash', ...request });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      tools: { functionDeclarations: Record<string, unknown>[] }[];
    };
    const declaration = body.tools[0].functionDeclarations[0];
    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toHaveProperty('$defs');
    expect(danglingRefs(declaration.parametersJsonSchema)).toEqual([]);
  });

  it('Gemini keeps flat schemas in parameters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      }),
    });
    const flat = toolToSchema(
      tool({
        name: 'get_weather',
        description: 'Weather',
        parameters: z.object({ city: z.string() }),
        execute: async () => 'sunny',
      })
    );
    await new GoogleBackend({ apiKey: 'k' }).chat({
      model: 'gemini-2.5-flash',
      messages: request.messages,
      tools: [flat],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as {
      tools: { functionDeclarations: Record<string, unknown>[] }[];
    };
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
  });
});
