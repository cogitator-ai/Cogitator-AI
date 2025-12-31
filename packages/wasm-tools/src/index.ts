/**
 * @cogitator-ai/wasm-tools - WASM-based tools for Cogitator agents
 *
 * This package provides pre-built WASM tools that run in the Extism sandbox.
 * WASM tools offer:
 * - 100-500x faster cold start than Docker
 * - Memory-safe execution in isolated sandbox
 * - ~20x lower memory footprint
 */

import { z } from 'zod';
import type { SandboxConfig } from '@cogitator-ai/types';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the path to a WASM module in this package
 */
export function getWasmPath(name: string): string {
  return join(__dirname, 'wasm', `${name}.wasm`);
}

/**
 * Calculator tool configuration for WASM execution
 */
export const calcToolConfig: SandboxConfig = {
  type: 'wasm',
  wasmModule: getWasmPath('calc'),
  wasmFunction: 'calculate',
  timeout: 5000,
};

/**
 * Calculator tool schema
 */
export const calcToolSchema = z.object({
  expression: z.string().describe('Mathematical expression to evaluate (e.g., "2 + 2 * 3")'),
});

/**
 * JSON processor tool configuration
 */
export const jsonToolConfig: SandboxConfig = {
  type: 'wasm',
  wasmModule: getWasmPath('json'),
  wasmFunction: 'process',
  timeout: 5000,
};

/**
 * JSON processor tool schema
 */
export const jsonToolSchema = z.object({
  json: z.string().describe('JSON string to parse and process'),
  query: z.string().optional().describe('Optional JSONPath query'),
});

export type CalcToolInput = z.infer<typeof calcToolSchema>;
export type JsonToolInput = z.infer<typeof jsonToolSchema>;
