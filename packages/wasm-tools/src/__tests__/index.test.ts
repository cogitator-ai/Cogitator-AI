import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../runtime.js', () => ({
  invokeWasm: vi.fn().mockResolvedValue({ ok: true }),
}));

import { invokeWasm } from '../runtime.js';
import {
  defineWasmTool,
  getWasmPath,
  createCalcTool,
  createHashTool,
  createJsonTool,
  createBase64Tool,
  createSlugTool,
  createValidationTool,
  createDiffTool,
  createRegexTool,
  createCsvTool,
  createMarkdownTool,
  createXmlTool,
  createDatetimeTool,
  createCompressionTool,
  createSigningTool,
  calcToolSchema,
  jsonToolSchema,
  hashToolSchema,
  base64ToolSchema,
  slugToolSchema,
  validationToolSchema,
  diffToolSchema,
  regexToolSchema,
  csvToolSchema,
  markdownToolSchema,
  xmlToolSchema,
  datetimeToolSchema,
  compressionToolSchema,
  signingToolSchema,
} from '../index.js';
import { z } from 'zod';

describe('defineWasmTool', () => {
  it('creates tool with correct sandbox config', () => {
    const tool = defineWasmTool({
      name: 'test',
      description: 'test tool',
      wasmModule: '/path/to/test.wasm',
      wasmFunction: 'run',
      parameters: z.object({ input: z.string() }),
      category: 'utility',
      tags: ['test'],
      timeout: 3000,
      wasi: true,
    });

    expect(tool.name).toBe('test');
    expect(tool.sandbox).toEqual({
      type: 'wasm',
      wasmModule: '/path/to/test.wasm',
      wasmFunction: 'run',
      timeout: 3000,
      wasi: true,
    });
  });

  it('defaults wasmFunction to "run" and timeout to 5000', () => {
    const tool = defineWasmTool({
      name: 'test',
      description: 'test',
      wasmModule: '/path.wasm',
      parameters: z.object({}),
    });

    expect(tool.sandbox!.wasmFunction).toBe('run');
    expect(tool.sandbox!.timeout).toBe(5000);
  });

  describe('execute', () => {
    beforeEach(() => {
      vi.mocked(invokeWasm).mockClear();
    });

    it('runs the WASM module with validated params and returns its output', async () => {
      const tool = defineWasmTool({
        name: 'test',
        description: 'test',
        wasmModule: '/path.wasm',
        wasmFunction: 'process',
        parameters: z.object({ a: z.string(), n: z.number().default(3) }),
        timeout: 1234,
        wasi: true,
      });
      const controller = new AbortController();

      const result = await tool.execute({ a: 'hello' } as never, {
        agentId: 'a',
        runId: 'r',
        signal: controller.signal,
      });

      expect(result).toEqual({ ok: true });
      expect(invokeWasm).toHaveBeenCalledWith({
        toolName: 'test',
        wasmModule: '/path.wasm',
        wasmFunction: 'process',
        wasi: true,
        timeout: 1234,
        input: JSON.stringify({ a: 'hello', n: 3 }),
        signal: controller.signal,
      });
    });

    it('rejects invalid params before touching WASM', async () => {
      const tool = defineWasmTool({
        name: 'test',
        description: 'test',
        wasmModule: '/path.wasm',
        parameters: z.object({ a: z.string() }),
      });

      await expect(tool.execute({ a: 1 } as never, {} as never)).rejects.toThrow();
      expect(invokeWasm).not.toHaveBeenCalled();
    });

    it('works without a tool context and exposes the timeout on the tool', async () => {
      const tool = defineWasmTool({
        name: 'test',
        description: 'test',
        wasmModule: '/path.wasm',
        parameters: z.object({}),
      });

      await tool.execute({}, undefined as never);
      expect(tool.timeout).toBe(5000);
      expect(vi.mocked(invokeWasm).mock.calls[0][0]).toMatchObject({
        wasi: false,
        signal: undefined,
      });
    });
  });

  it('all pre-built tools enable WASI, which extism-js compiled plugins require', () => {
    const tools = [
      createCalcTool(),
      createHashTool(),
      createJsonTool(),
      createBase64Tool(),
      createSlugTool(),
      createValidationTool(),
      createDiffTool(),
      createRegexTool(),
      createCsvTool(),
      createMarkdownTool(),
      createXmlTool(),
      createDatetimeTool(),
      createCompressionTool(),
      createSigningTool(),
    ];
    for (const tool of tools) {
      expect(tool.sandbox?.wasi).toBe(true);
      expect(tool.timeout).toBe(tool.sandbox?.timeout);
    }
  });

  describe('signingToolSchema seed generation', () => {
    it('adds a secure random hex seed for generateKeypair when none is given', () => {
      const first = signingToolSchema.parse({ operation: 'generateKeypair', algorithm: 'ed25519' });
      const second = signingToolSchema.parse({
        operation: 'generateKeypair',
        algorithm: 'ed25519',
      });
      expect(first.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(first.seed).not.toBe(second.seed);
    });

    it('encodes the generated seed as base64 when requested', () => {
      const parsed = signingToolSchema.parse({
        operation: 'generateKeypair',
        algorithm: 'ed25519',
        encoding: 'base64',
      });
      expect(Buffer.from(parsed.seed!, 'base64')).toHaveLength(32);
    });

    it('keeps a caller-provided seed and leaves other operations untouched', () => {
      expect(
        signingToolSchema.parse({ operation: 'generateKeypair', algorithm: 'ed25519', seed: 'ab' })
          .seed
      ).toBe('ab');
      expect(
        signingToolSchema.parse({ operation: 'sign', algorithm: 'ed25519', message: 'm' }).seed
      ).toBeUndefined();
    });

    it('still exposes the input schema to the LLM', () => {
      const json = createSigningTool().toJSON();
      expect(json.parameters.properties).toHaveProperty('operation');
      expect(json.parameters.properties).toHaveProperty('seed');
      expect(json.parameters.required).toEqual(['operation', 'algorithm']);
    });
  });

  it('toJSON returns OpenAPI-compatible schema', () => {
    const tool = defineWasmTool({
      name: 'my_tool',
      description: 'My tool description',
      wasmModule: '/path.wasm',
      parameters: z.object({
        text: z.string(),
        count: z.number().optional(),
      }),
    });

    const json = tool.toJSON();
    expect(json.name).toBe('my_tool');
    expect(json.description).toBe('My tool description');
    expect(json.parameters.type).toBe('object');
    expect(json.parameters.properties).toHaveProperty('text');
    expect(json.parameters.properties).toHaveProperty('count');
  });
});

describe('defineWasmTool schemas', () => {
  it('keeps the definitions a recursive parameter schema refers to', () => {
    interface Expr {
      op: string;
      args: Expr[];
    }
    const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
      z.object({ op: z.string(), args: z.array(ExprSchema) })
    );
    const tool = defineWasmTool({
      name: 'evaluate',
      description: 'Evaluate an expression tree',
      wasmModule: '/path.wasm',
      parameters: z.object({ expr: ExprSchema }),
    });

    const { parameters } = tool.toJSON();
    const ref = (parameters.properties.expr as { $ref: string }).$ref;
    const [, container, name] = ref.split('/');

    expect(parameters).not.toHaveProperty('$schema');
    expect((parameters[container] as Record<string, unknown>)[name]).toMatchObject({
      type: 'object',
    });
  });
});

describe('getWasmPath', () => {
  it('returns path ending with .wasm', () => {
    const path = getWasmPath('calc');
    expect(path).toMatch(/calc\.wasm$/);
  });

  it('works for all 14 plugin names', () => {
    const names = [
      'base64',
      'calc',
      'compression',
      'csv',
      'datetime',
      'diff',
      'hash',
      'json',
      'markdown',
      'regex',
      'signing',
      'slug',
      'validation',
      'xml',
    ];
    for (const name of names) {
      const path = getWasmPath(name);
      expect(path).toMatch(new RegExp(`${name}\\.wasm$`));
    }
  });
});

describe('tool factory functions', () => {
  const factories = [
    { fn: createCalcTool, name: 'calculate', func: 'calculate' },
    { fn: createHashTool, name: 'hash_text', func: 'hash' },
    { fn: createJsonTool, name: 'process_json', func: 'process' },
    { fn: createBase64Tool, name: 'base64', func: 'base64' },
    { fn: createSlugTool, name: 'slug', func: 'slug' },
    { fn: createValidationTool, name: 'validate', func: 'validate' },
    { fn: createDiffTool, name: 'diff', func: 'diff' },
    { fn: createRegexTool, name: 'regex', func: 'regex' },
    { fn: createCsvTool, name: 'csv', func: 'csv' },
    { fn: createMarkdownTool, name: 'markdown', func: 'markdown' },
    { fn: createXmlTool, name: 'xml', func: 'xml' },
    { fn: createDatetimeTool, name: 'datetime', func: 'datetime' },
    { fn: createCompressionTool, name: 'compression', func: 'compression' },
    { fn: createSigningTool, name: 'signing', func: 'signing' },
  ];

  for (const { fn, name, func } of factories) {
    it(`${name}: correct name and wasmFunction`, () => {
      const tool = fn();
      expect(tool.name).toBe(name);
      expect(tool.sandbox!.wasmFunction).toBe(func);
      expect(tool.sandbox!.type).toBe('wasm');
    });
  }

  it('accepts custom timeout', () => {
    const tool = createCalcTool({ timeout: 10000 });
    expect(tool.sandbox!.timeout).toBe(10000);
  });
});

describe('schema validation', () => {
  it('calcToolSchema accepts valid expression', () => {
    expect(calcToolSchema.safeParse({ expression: '2+2' }).success).toBe(true);
    expect(calcToolSchema.safeParse({}).success).toBe(false);
  });

  it('jsonToolSchema accepts json string with optional query', () => {
    expect(jsonToolSchema.safeParse({ json: '{}' }).success).toBe(true);
    expect(jsonToolSchema.safeParse({ json: '{}', query: '$.a' }).success).toBe(true);
    expect(jsonToolSchema.safeParse({}).success).toBe(false);
  });

  it('hashToolSchema validates algorithm enum', () => {
    expect(hashToolSchema.safeParse({ text: 'hi', algorithm: 'sha256' }).success).toBe(true);
    expect(hashToolSchema.safeParse({ text: 'hi', algorithm: 'sha1' }).success).toBe(true);
    expect(hashToolSchema.safeParse({ text: 'hi', algorithm: 'md5' }).success).toBe(true);
    expect(hashToolSchema.safeParse({ text: 'hi', algorithm: 'sha512' }).success).toBe(false);
  });

  it('base64ToolSchema validates operation enum', () => {
    expect(base64ToolSchema.safeParse({ text: 'hi', operation: 'encode' }).success).toBe(true);
    expect(base64ToolSchema.safeParse({ text: 'hi', operation: 'decode' }).success).toBe(true);
    expect(base64ToolSchema.safeParse({ text: 'hi', operation: 'invalid' }).success).toBe(false);
  });

  it('signingToolSchema only accepts ed25519', () => {
    expect(
      signingToolSchema.safeParse({
        operation: 'generateKeypair',
        algorithm: 'ed25519',
      }).success
    ).toBe(true);
    expect(
      signingToolSchema.safeParse({
        operation: 'generateKeypair',
        algorithm: 'ecdsa-p256',
      }).success
    ).toBe(false);
  });

  it('csvToolSchema accepts string or array data', () => {
    expect(
      csvToolSchema.safeParse({
        data: 'a,b\n1,2',
        operation: 'parse',
      }).success
    ).toBe(true);
    expect(
      csvToolSchema.safeParse({
        data: [
          ['a', 'b'],
          ['1', '2'],
        ],
        operation: 'stringify',
      }).success
    ).toBe(true);
  });

  it('validationToolSchema validates type enum', () => {
    for (const type of ['email', 'url', 'uuid', 'ipv4', 'ipv6']) {
      expect(validationToolSchema.safeParse({ value: 'test', type }).success).toBe(true);
    }
    expect(validationToolSchema.safeParse({ value: 'test', type: 'phone' }).success).toBe(false);
  });

  it('compressionToolSchema validates operation and encodings', () => {
    expect(
      compressionToolSchema.safeParse({
        data: 'hello',
        operation: 'compress',
      }).success
    ).toBe(true);
    expect(
      compressionToolSchema.safeParse({
        data: 'hello',
        operation: 'compress',
        inputEncoding: 'utf8',
        outputEncoding: 'base64',
        level: 6,
      }).success
    ).toBe(true);
  });

  it('diffToolSchema accepts original and modified', () => {
    expect(
      diffToolSchema.safeParse({
        original: 'hello',
        modified: 'world',
      }).success
    ).toBe(true);
  });

  it('regexToolSchema validates operation enum', () => {
    for (const op of ['match', 'matchAll', 'test', 'replace', 'split']) {
      expect(
        regexToolSchema.safeParse({
          text: 'hello',
          pattern: 'h',
          operation: op,
        }).success
      ).toBe(true);
    }
  });

  it('datetimeToolSchema validates operation enum', () => {
    for (const op of ['parse', 'format', 'add', 'subtract', 'diff', 'now']) {
      expect(datetimeToolSchema.safeParse({ operation: op }).success).toBe(true);
    }
  });

  it('markdownToolSchema accepts markdown with options', () => {
    expect(markdownToolSchema.safeParse({ markdown: '# Hello' }).success).toBe(true);
    expect(
      markdownToolSchema.safeParse({
        markdown: '# Hello',
        options: { sanitize: true, gfm: true },
      }).success
    ).toBe(true);
  });

  it('xmlToolSchema accepts xml with optional query', () => {
    expect(xmlToolSchema.safeParse({ xml: '<root/>' }).success).toBe(true);
    expect(xmlToolSchema.safeParse({ xml: '<root/>', query: '/root' }).success).toBe(true);
  });

  it('slugToolSchema accepts text with options', () => {
    expect(slugToolSchema.safeParse({ text: 'Hello World' }).success).toBe(true);
    expect(
      slugToolSchema.safeParse({
        text: 'Hello',
        separator: '_',
        lowercase: false,
        maxLength: 50,
      }).success
    ).toBe(true);
  });
});
