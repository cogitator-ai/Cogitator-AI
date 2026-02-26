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
  const jsonSchema = z.toJSONSchema(t.parameters as ZodType, {
    target: 'openapi-3.0',
    unrepresentable: 'any',
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

export const slugToolSchema = z.object({
  text: z.string().describe('Text to convert to URL-safe slug'),
  separator: z.string().optional().describe('Separator character (default: "-")'),
  lowercase: z.boolean().optional().describe('Convert to lowercase (default: true)'),
  maxLength: z.number().optional().describe('Maximum length of the slug'),
});

export const validationToolSchema = z.object({
  value: z.string().describe('Value to validate'),
  type: z.enum(['email', 'url', 'uuid', 'ipv4', 'ipv6']).describe('Type of validation'),
});

export const diffToolSchema = z.object({
  original: z.string().describe('Original text'),
  modified: z.string().describe('Modified text'),
  format: z.enum(['unified', 'inline', 'json']).optional().describe('Output format'),
  context: z.number().optional().describe('Context lines for unified diff'),
});

export const regexToolSchema = z.object({
  text: z.string().describe('Text to search/replace'),
  pattern: z.string().describe('Regular expression pattern'),
  flags: z.string().optional().describe('Regex flags (g, i, m, etc.)'),
  operation: z.enum(['match', 'matchAll', 'test', 'replace', 'split']).describe('Operation'),
  replacement: z.string().optional().describe('Replacement text for replace operation'),
  limit: z.number().optional().describe('Limit number of matches/splits'),
});

export const csvToolSchema = z.object({
  data: z.union([z.string(), z.array(z.array(z.unknown()))]).describe('CSV string or array data'),
  operation: z.enum(['parse', 'stringify']).describe('Parse CSV string or stringify array'),
  delimiter: z.string().optional().describe('Field delimiter (default: ",")'),
  quote: z.string().optional().describe("Quote character (default: '\"')"),
  headers: z
    .union([z.boolean(), z.array(z.string())])
    .optional()
    .describe('Handle headers'),
});

export const markdownToolSchema = z.object({
  markdown: z.string().describe('Markdown text to convert'),
  options: z
    .object({
      sanitize: z.boolean().optional().describe('Sanitize HTML output'),
      gfm: z.boolean().optional().describe('Enable GitHub Flavored Markdown'),
    })
    .optional(),
});

export const xmlToolSchema = z.object({
  xml: z.string().describe('XML string to parse'),
  query: z.string().optional().describe('XPath-like query (e.g., "/root/child", "//element")'),
});

export const datetimeToolSchema = z.object({
  date: z.string().optional().describe('Date string to process'),
  operation: z.enum(['parse', 'format', 'add', 'subtract', 'diff', 'now']).describe('Operation'),
  format: z.string().optional().describe('Date format (YYYY, MM, DD, HH, mm, ss, SSS, Z)'),
  timezone: z.string().optional().describe('Timezone offset (e.g., "+04:00", "UTC")'),
  amount: z.number().optional().describe('Amount for add/subtract'),
  unit: z
    .enum(['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'])
    .optional(),
  endDate: z.string().optional().describe('End date for diff operation'),
});

export const compressionToolSchema = z.object({
  data: z.string().describe('Data to compress/decompress'),
  operation: z.enum(['compress', 'decompress']).describe('Operation'),
  inputEncoding: z.enum(['base64', 'utf8']).optional().describe('Input encoding'),
  outputEncoding: z.enum(['base64', 'utf8']).optional().describe('Output encoding'),
  level: z.number().optional().describe('Compression level (0-9)'),
});

export const signingToolSchema = z.object({
  operation: z.enum(['generateKeypair', 'sign', 'verify']).describe('Operation'),
  algorithm: z.enum(['ed25519']).describe('Signing algorithm'),
  message: z.string().optional().describe('Message to sign/verify'),
  privateKey: z.string().optional().describe('Private key (hex or base64)'),
  publicKey: z.string().optional().describe('Public key (hex or base64)'),
  signature: z.string().optional().describe('Signature to verify'),
  encoding: z.enum(['hex', 'base64']).optional().describe('Key/signature encoding'),
});

export function createSlugTool(options?: { timeout?: number }): Tool<SlugToolInput, unknown> {
  return defineWasmTool({
    name: 'slug',
    description: 'Convert text to URL-safe slug with transliteration support',
    wasmModule: getWasmPath('slug'),
    wasmFunction: 'slug',
    parameters: slugToolSchema,
    category: 'utility',
    tags: ['slug', 'url', 'text'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createValidationTool(options?: {
  timeout?: number;
}): Tool<ValidationToolInput, unknown> {
  return defineWasmTool({
    name: 'validate',
    description: 'Validate email, URL, UUID, IPv4, or IPv6 addresses',
    wasmModule: getWasmPath('validation'),
    wasmFunction: 'validate',
    parameters: validationToolSchema,
    category: 'utility',
    tags: ['validation', 'email', 'url', 'uuid', 'ip'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createDiffTool(options?: { timeout?: number }): Tool<DiffToolInput, unknown> {
  return defineWasmTool({
    name: 'diff',
    description: 'Generate diff between two texts using Myers algorithm',
    wasmModule: getWasmPath('diff'),
    wasmFunction: 'diff',
    parameters: diffToolSchema,
    category: 'utility',
    tags: ['diff', 'text', 'compare'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createRegexTool(options?: { timeout?: number }): Tool<RegexToolInput, unknown> {
  return defineWasmTool({
    name: 'regex',
    description: 'Execute regex operations with ReDoS protection',
    wasmModule: getWasmPath('regex'),
    wasmFunction: 'regex',
    parameters: regexToolSchema,
    category: 'utility',
    tags: ['regex', 'pattern', 'search', 'replace'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createCsvTool(options?: { timeout?: number }): Tool<CsvToolInput, unknown> {
  return defineWasmTool({
    name: 'csv',
    description: 'Parse and generate CSV data (RFC 4180 compliant)',
    wasmModule: getWasmPath('csv'),
    wasmFunction: 'csv',
    parameters: csvToolSchema,
    category: 'utility',
    tags: ['csv', 'parse', 'data'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createMarkdownTool(options?: {
  timeout?: number;
}): Tool<MarkdownToolInput, unknown> {
  return defineWasmTool({
    name: 'markdown',
    description: 'Convert Markdown to HTML (GFM subset)',
    wasmModule: getWasmPath('markdown'),
    wasmFunction: 'markdown',
    parameters: markdownToolSchema,
    category: 'utility',
    tags: ['markdown', 'html', 'convert'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createXmlTool(options?: { timeout?: number }): Tool<XmlToolInput, unknown> {
  return defineWasmTool({
    name: 'xml',
    description: 'Parse XML to JSON with XPath-like query support',
    wasmModule: getWasmPath('xml'),
    wasmFunction: 'xml',
    parameters: xmlToolSchema,
    category: 'utility',
    tags: ['xml', 'parse', 'query'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createDatetimeTool(options?: {
  timeout?: number;
}): Tool<DatetimeToolInput, unknown> {
  return defineWasmTool({
    name: 'datetime',
    description: 'Parse, format, and manipulate dates (UTC + offset timezones)',
    wasmModule: getWasmPath('datetime'),
    wasmFunction: 'datetime',
    parameters: datetimeToolSchema,
    category: 'utility',
    tags: ['datetime', 'date', 'time', 'format'],
    timeout: options?.timeout ?? 5000,
  });
}

export function createCompressionTool(options?: {
  timeout?: number;
}): Tool<CompressionToolInput, unknown> {
  return defineWasmTool({
    name: 'compression',
    description: 'Compress and decompress data using gzip',
    wasmModule: getWasmPath('compression'),
    wasmFunction: 'compression',
    parameters: compressionToolSchema,
    category: 'utility',
    tags: ['compression', 'gzip', 'deflate'],
    timeout: options?.timeout ?? 10000,
  });
}

export function createSigningTool(options?: { timeout?: number }): Tool<SigningToolInput, unknown> {
  return defineWasmTool({
    name: 'signing',
    description: 'Digital signatures with Ed25519 (keypair generation, sign, verify)',
    wasmModule: getWasmPath('signing'),
    wasmFunction: 'signing',
    parameters: signingToolSchema,
    category: 'utility',
    tags: ['signing', 'ed25519', 'verify'],
    timeout: options?.timeout ?? 10000,
  });
}

export type SlugToolInput = z.infer<typeof slugToolSchema>;
export type ValidationToolInput = z.infer<typeof validationToolSchema>;
export type DiffToolInput = z.infer<typeof diffToolSchema>;
export type RegexToolInput = z.infer<typeof regexToolSchema>;
export type CsvToolInput = z.infer<typeof csvToolSchema>;
export type MarkdownToolInput = z.infer<typeof markdownToolSchema>;
export type XmlToolInput = z.infer<typeof xmlToolSchema>;
export type DatetimeToolInput = z.infer<typeof datetimeToolSchema>;
export type CompressionToolInput = z.infer<typeof compressionToolSchema>;
export type SigningToolInput = z.infer<typeof signingToolSchema>;

export * from './manager/index.js';
