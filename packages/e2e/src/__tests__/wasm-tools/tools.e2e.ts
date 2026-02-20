import { describe, it, expect } from 'vitest';
import {
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
  defineWasmTool,
  getWasmPath,
  WasmToolManager,
  calcToolSchema,
  hashToolSchema,
} from '@cogitator-ai/wasm-tools';
import { z } from 'zod';

describe('WASM Tools: Tool Creation & Schemas', () => {
  it('createCalcTool returns valid Tool shape', () => {
    const tool = createCalcTool();

    expect(tool.name).toBe('calculate');
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.execute).toBeTypeOf('function');
    expect(tool.sandbox).toBeDefined();
    expect(tool.sandbox!.type).toBe('wasm');
    expect(tool.sandbox!.wasmFunction).toBe('calculate');
    expect(tool.category).toBe('math');
    expect(tool.toJSON).toBeTypeOf('function');
  });

  it('createHashTool returns valid Tool shape', () => {
    const tool = createHashTool();

    expect(tool.name).toBe('hash_text');
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toBeDefined();
    expect(tool.sandbox).toBeDefined();
    expect(tool.sandbox!.type).toBe('wasm');
    expect(tool.sandbox!.wasmFunction).toBe('hash');
  });

  it('all 14 pre-built tools have unique names', () => {
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

    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(14);

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.sandbox).toBeDefined();
      expect(tool.sandbox!.type).toBe('wasm');
    }
  });

  it('defineWasmTool creates custom tool', () => {
    const customSchema = z.object({
      input: z.string(),
    });

    const tool = defineWasmTool({
      name: 'custom_tool',
      description: 'A custom WASM tool for testing',
      wasmModule: '/tmp/custom.wasm',
      wasmFunction: 'process',
      parameters: customSchema,
      category: 'utility',
      tags: ['custom', 'test'],
      timeout: 3000,
    });

    expect(tool.name).toBe('custom_tool');
    expect(tool.description).toBe('A custom WASM tool for testing');
    expect(tool.category).toBe('utility');
    expect(tool.tags).toEqual(['custom', 'test']);
    expect(tool.sandbox).toBeDefined();
    expect(tool.sandbox!.type).toBe('wasm');
    expect(tool.sandbox!.wasmModule).toBe('/tmp/custom.wasm');
    expect(tool.sandbox!.wasmFunction).toBe('process');
    expect(tool.sandbox!.timeout).toBe(3000);
  });

  it('tool schemas validate correct input', () => {
    const calcResult = calcToolSchema.safeParse({ expression: '2+2' });
    expect(calcResult.success).toBe(true);

    const hashResult = hashToolSchema.safeParse({ text: 'hello', algorithm: 'sha256' });
    expect(hashResult.success).toBe(true);
  });

  it('tool schemas reject invalid input', () => {
    const emptyCalc = calcToolSchema.safeParse({});
    expect(emptyCalc.success).toBe(false);

    const badHash = hashToolSchema.safeParse({ text: 'hello', algorithm: 'sha512' });
    expect(badHash.success).toBe(false);

    const missingText = hashToolSchema.safeParse({ algorithm: 'sha256' });
    expect(missingText.success).toBe(false);
  });

  it('hashToolSchema accepts all valid algorithms', () => {
    for (const alg of ['sha256', 'sha1', 'md5'] as const) {
      const result = hashToolSchema.safeParse({ text: 'test', algorithm: alg });
      expect(result.success).toBe(true);
    }
  });

  it('tool toJSON produces OpenAPI-compatible schema', () => {
    const tool = createCalcTool();
    const json = tool.toJSON();

    expect(json.name).toBe('calculate');
    expect(json.description).toBeTruthy();
    expect(json.parameters).toBeDefined();
    expect(json.parameters.type).toBe('object');
    expect(json.parameters.properties).toBeDefined();
    expect(json.parameters.properties).toHaveProperty('expression');
  });

  it('getWasmPath returns correct path', () => {
    const calcPath = getWasmPath('calc');
    expect(calcPath).toContain('wasm');
    expect(calcPath).toMatch(/calc\.wasm$/);

    const hashPath = getWasmPath('hash');
    expect(hashPath).toContain('wasm');
    expect(hashPath).toMatch(/hash\.wasm$/);
  });

  it('WasmToolManager initializes empty', () => {
    const manager = new WasmToolManager();
    const tools = manager.getTools();
    expect(tools).toEqual([]);
  });

  it('WasmToolManager close is idempotent', async () => {
    const manager = new WasmToolManager();
    await manager.close();
    await manager.close();
    expect(manager.getTools()).toEqual([]);
  });
});
