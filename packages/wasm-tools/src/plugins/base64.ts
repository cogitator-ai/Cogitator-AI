/**
 * Base64 WASM Plugin
 *
 * This file is compiled to WASM using the Extism JS PDK.
 * It provides base64 encoding and decoding functions.
 *
 * Build command:
 *   esbuild src/plugins/base64.ts -o dist/temp/base64.js --bundle --format=cjs --target=es2020
 *   extism-js dist/temp/base64.js -o dist/wasm/base64.wasm
 */

import { base64Decode, base64Encode, utf8Decode, utf8Encode } from './shared/encoding';

interface Base64Input {
  text: string;
  operation: 'encode' | 'decode';
  urlSafe?: boolean;
}

interface Base64Output {
  result: string;
  operation: string;
  error?: string;
}

function encodeBase64(input: string, urlSafe: boolean): string {
  return base64Encode(utf8Encode(input), urlSafe);
}

function decodeBase64(input: string): string {
  return utf8Decode(base64Decode(input));
}

export function base64(): number {
  let operation = 'unknown';
  try {
    const inputStr = Host.inputString();
    const input: Base64Input = JSON.parse(inputStr);
    operation = String(input.operation);
    const urlSafe = input.urlSafe ?? false;

    if (input.operation !== 'encode' && input.operation !== 'decode') {
      throw new Error(`Unknown operation: ${input.operation}`);
    }

    let result: string;
    if (input.operation === 'encode') {
      result = encodeBase64(input.text, urlSafe);
    } else {
      result = decodeBase64(input.text);
    }

    const output: Base64Output = {
      result,
      operation: input.operation,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: Base64Output = {
      result: '',
      operation,
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
