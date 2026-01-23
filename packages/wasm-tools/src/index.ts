/**
 * @cogitator-ai/wasm-tools - WASM-based tools for Cogitator agents
 *
 * This package provides pre-built WASM tools and a framework for creating
 * custom WASM tools that run in the Extism sandbox.
 *
 * WASM tools offer:
 * - 100-500x faster cold start than Docker
 * - Memory-safe execution in isolated sandbox
 * - ~20x lower memory footprint
 *
 * @example
 * ```ts
 * import { defineWasmTool, createCalcTool } from '@cogitator-ai/wasm-tools';
 *
 * // Use pre-built tools
 * const calc = createCalcTool();
 *
 * // Create custom WASM tools
 * const myTool = defineWasmTool({
 *   name: 'image_processor',
 *   description: 'Process images in WASM sandbox',
 *   wasmModule: './my-image-proc.wasm',
 *   wasmFunction: 'process',
 *   parameters: z.object({
 *     imageData: z.string(),
 *     operation: z.enum(['resize', 'crop', 'rotate']),
 *   }),
 * });
 * ```
 */

import { z, type ZodType } from 'zod';
import type { Tool, SandboxConfig, ToolContext, ToolCategory } from '@cogitator-ai/types';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Configuration for defining a custom WASM tool
 */
export interface WasmToolConfig<TParams = unknown> {
  name: string;
  description: string;
  wasmModule: string;
  wasmFunction?: string;
  parameters: ZodType<TParams>;
  category?: ToolCategory;
  tags?: string[];
  timeout?: number;
  wasi?: boolean;
  memoryPages?: number;
}

/**
 * Create a custom WASM tool for agent use.
 *
 * WASM tools run in an isolated Extism sandbox with memory-safe execution.
 * The execute function passes parameters to the WASM module, which handles
 * the actual computation.
 *
 * @param config - WASM tool configuration
 * @returns A Tool instance configured for WASM sandbox execution
 *
 * @example
 * ```ts
 * const hashTool = defineWasmTool({
 *   name: 'hash_text',
 *   description: 'Hash text using various algorithms',
 *   wasmModule: './hash.wasm',
 *   wasmFunction: 'hash',
 *   parameters: z.object({
 *     text: z.string(),
 *     algorithm: z.enum(['sha256', 'sha512', 'md5']),
 *   }),
 * });
 *
 * // Use with an agent
 * const agent = new Agent({
 *   name: 'hasher',
 *   tools: [hashTool],
 * });
 * ```
 */
export function defineWasmTool<TParams>(config: WasmToolConfig<TParams>): Tool<TParams, unknown> {
  const sandboxConfig: SandboxConfig = {
    type: 'wasm',
    wasmModule: config.wasmModule,
    wasmFunction: config.wasmFunction ?? 'run',
    timeout: config.timeout ?? 5000,
    wasi: config.wasi,
  };

  const tool: Tool<TParams, unknown> = {
    name: config.name,
    description: config.description,
    category: config.category,
    tags: config.tags,
    parameters: config.parameters,
    sandbox: sandboxConfig,
    execute: async (params: TParams, _context: ToolContext) => {
      return params;
    },
    toJSON: () => wasmToolToSchema(tool),
  };

  return tool;
}

function wasmToolToSchema<TParams>(t: Tool<TParams, unknown>) {
  const jsonSchema = zodToJsonSchema(t.parameters as ZodType, {
    target: 'openApi3',
    $refStrategy: 'none',
  });

  const schema = jsonSchema as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = schema.required as string[] | undefined;

  return {
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object' as const,
      properties,
      required,
    },
  };
}

/**
 * Get the path to a pre-built WASM module in this package
 */
export function getWasmPath(name: string): string {
  return join(__dirname, 'wasm', `${name}.wasm`);
}

export const calcToolSchema = z.object({
  expression: z.string().describe('Mathematical expression to evaluate (e.g., "2 + 2 * 3")'),
});

export const jsonToolSchema = z.object({
  json: z.string().describe('JSON string to parse and process'),
  query: z.string().optional().describe('Optional JSONPath query'),
});

export const hashToolSchema = z.object({
  text: z.string().describe('Text to hash'),
  algorithm: z.enum(['sha256', 'sha1', 'md5']).describe('Hash algorithm to use'),
});

export const base64ToolSchema = z.object({
  text: z.string().describe('Text to encode or decode'),
  operation: z.enum(['encode', 'decode']).describe('Whether to encode or decode'),
  urlSafe: z.boolean().optional().describe('Use URL-safe Base64 variant'),
});

/**
 * Create a calculator WASM tool.
 *
 * Evaluates mathematical expressions safely in a WASM sandbox.
 * Supports basic arithmetic: +, -, *, /, %, parentheses.
 *
 * @param options - Optional configuration overrides
 * @returns A Tool for mathematical calculations
 *
 * @example
 * ```ts
 * const calc = createCalcTool();
 * const agent = new Agent({ tools: [calc] });
 *
 * // Agent can now use: calculate({ expression: "2 + 2 * 3" })
 * ```
 */
export function createCalcTool(options?: { timeout?: number }): Tool<CalcToolInput, unknown> {
  return defineWasmTool({
    name: 'calculate',
    description:
      'Evaluate a mathematical expression safely. Supports +, -, *, /, %, and parentheses.',
    wasmModule: getWasmPath('calc'),
    wasmFunction: 'calculate',
    parameters: calcToolSchema,
    category: 'math',
    tags: ['calculation', 'math', 'arithmetic'],
    timeout: options?.timeout ?? 5000,
  });
}

/**
 * Create a JSON processor WASM tool.
 *
 * Parses and queries JSON data safely in a WASM sandbox.
 * Supports JSONPath queries for extracting nested data.
 *
 * @param options - Optional configuration overrides
 * @returns A Tool for JSON processing
 *
 * @example
 * ```ts
 * const jsonTool = createJsonTool();
 * const agent = new Agent({ tools: [jsonTool] });
 *
 * // Agent can now use: process_json({ json: '{"a": 1}', query: '$.a' })
 * ```
 */
export function createJsonTool(options?: { timeout?: number }): Tool<JsonToolInput, unknown> {
  return defineWasmTool({
    name: 'process_json',
    description:
      'Parse and query JSON data. Supports JSONPath queries for extracting nested values.',
    wasmModule: getWasmPath('json'),
    wasmFunction: 'process',
    parameters: jsonToolSchema,
    category: 'utility',
    tags: ['json', 'parsing', 'query'],
    timeout: options?.timeout ?? 5000,
  });
}

/**
 * Create a hash WASM tool.
 *
 * Computes cryptographic hashes safely in a WASM sandbox.
 * Supports SHA-256, SHA-1, and MD5 algorithms.
 *
 * @param options - Optional configuration overrides
 * @returns A Tool for hashing text
 *
 * @example
 * ```ts
 * const hashTool = createHashTool();
 * const agent = new Agent({ tools: [hashTool] });
 *
 * // Agent can now use: hash_text({ text: "hello", algorithm: "sha256" })
 * ```
 */
export function createHashTool(options?: { timeout?: number }): Tool<HashToolInput, unknown> {
  return defineWasmTool({
    name: 'hash_text',
    description: 'Compute cryptographic hash of text. Supports SHA-256, SHA-1, and MD5 algorithms.',
    wasmModule: getWasmPath('hash'),
    wasmFunction: 'hash',
    parameters: hashToolSchema,
    category: 'utility',
    tags: ['hash', 'crypto', 'sha256', 'md5'],
    timeout: options?.timeout ?? 5000,
  });
}

/**
 * Create a Base64 encoding/decoding WASM tool.
 *
 * Encodes and decodes Base64 safely in a WASM sandbox.
 * Supports both standard and URL-safe Base64 variants.
 *
 * @param options - Optional configuration overrides
 * @returns A Tool for Base64 operations
 *
 * @example
 * ```ts
 * const b64Tool = createBase64Tool();
 * const agent = new Agent({ tools: [b64Tool] });
 *
 * // Agent can now use: base64({ text: "hello", operation: "encode" })
 * ```
 */
export function createBase64Tool(options?: { timeout?: number }): Tool<Base64ToolInput, unknown> {
  return defineWasmTool({
    name: 'base64',
    description: 'Encode or decode Base64 text. Supports standard and URL-safe variants.',
    wasmModule: getWasmPath('base64'),
    wasmFunction: 'base64',
    parameters: base64ToolSchema,
    category: 'utility',
    tags: ['base64', 'encoding', 'decoding'],
    timeout: options?.timeout ?? 5000,
  });
}

export const calcToolConfig: SandboxConfig = {
  type: 'wasm',
  wasmModule: getWasmPath('calc'),
  wasmFunction: 'calculate',
  timeout: 5000,
};

export const jsonToolConfig: SandboxConfig = {
  type: 'wasm',
  wasmModule: getWasmPath('json'),
  wasmFunction: 'process',
  timeout: 5000,
};

export const hashToolConfig: SandboxConfig = {
  type: 'wasm',
  wasmModule: getWasmPath('hash'),
  wasmFunction: 'hash',
  timeout: 5000,
};

export const base64ToolConfig: SandboxConfig = {
  type: 'wasm',
  wasmModule: getWasmPath('base64'),
  wasmFunction: 'base64',
  timeout: 5000,
};

export type CalcToolInput = z.infer<typeof calcToolSchema>;
export type JsonToolInput = z.infer<typeof jsonToolSchema>;
export type HashToolInput = z.infer<typeof hashToolSchema>;
export type Base64ToolInput = z.infer<typeof base64ToolSchema>;

export * from './manager/index.js';
