import { describe, it, expect } from 'vitest';
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

  it('execute returns params as passthrough', async () => {
    const tool = defineWasmTool({
      name: 'test',
      description: 'test',
      wasmModule: '/path.wasm',
      parameters: z.object({ a: z.string() }),
    });

    const result = await tool.execute({ a: 'hello' }, {} as never);
    expect(result).toEqual({ a: 'hello' });
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
