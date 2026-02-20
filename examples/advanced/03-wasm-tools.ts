import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import {
  createCalcTool,
  createHashTool,
  createBase64Tool,
  createJsonTool,
  createRegexTool,
  createCsvTool,
  createValidationTool,
  createDiffTool,
  createSlugTool,
  createDatetimeTool,
  defineWasmTool,
  getWasmPath,
} from '@cogitator-ai/wasm-tools';
import { z } from 'zod';

async function main() {
  header('03 — WASM-Sandboxed Tools');

  const cog = createCogitator();

  section('1. Pre-built WASM tools — overview');

  const calc = createCalcTool();
  const hash = createHashTool();
  const base64 = createBase64Tool();
  const json = createJsonTool();
  const regex = createRegexTool();
  const csv = createCsvTool();
  const validation = createValidationTool();
  const diff = createDiffTool();
  const slug = createSlugTool();
  const datetime = createDatetimeTool();

  const allTools = [calc, hash, base64, json, regex, csv, validation, diff, slug, datetime];

  console.log(`  Available WASM tools: ${allTools.length}`);
  for (const t of allTools) {
    const schema = t.toJSON!();
    const paramCount = Object.keys(schema.parameters.properties ?? {}).length;
    console.log(`    ${schema.name.padEnd(16)} ${paramCount} params   ${schema.description}`);
  }

  section('2. Sandbox configuration');

  console.log('  Each tool runs in an isolated WASM sandbox:');
  console.log(`    calc sandbox:  ${JSON.stringify(calc.sandbox)}`);
  console.log(`    hash sandbox:  ${JSON.stringify(hash.sandbox)}`);

  section('3. Tool schemas (what the LLM sees)');

  const calcSchema = calc.toJSON!();
  console.log('  Calculator tool schema:');
  console.log(`    Name: ${calcSchema.name}`);
  console.log(`    Description: ${calcSchema.description}`);
  console.log(`    Parameters: ${JSON.stringify(calcSchema.parameters, null, 2)}`);

  section('4. Custom WASM tool definition');

  const textStats = defineWasmTool({
    name: 'text_stats',
    description: 'Analyze text and return word count, character count, and average word length',
    wasmModule: getWasmPath('text-stats'),
    wasmFunction: 'analyze',
    parameters: z.object({
      text: z.string().describe('Text to analyze'),
      countWhitespace: z.boolean().optional().describe('Include whitespace in char count'),
    }),
    category: 'utility',
    tags: ['text', 'analysis', 'statistics'],
    timeout: 3000,
    wasi: false,
  });

  const customSchema = textStats.toJSON!();
  console.log('  Custom tool defined:');
  console.log(`    Name: ${customSchema.name}`);
  console.log(`    Sandbox type: ${textStats.sandbox?.type}`);
  console.log(`    WASM function: ${textStats.sandbox?.wasmFunction}`);
  console.log(`    Timeout: ${textStats.sandbox?.timeout}ms`);
  console.log(`    Category: ${textStats.category}`);
  console.log(`    Tags: ${textStats.tags?.join(', ')}`);

  section('5. Agent with WASM tools — data processing');

  const dataAgent = new Agent({
    name: 'data-processor',
    model: DEFAULT_MODEL,
    instructions: `You are a data processing assistant with access to sandboxed WASM tools.
Use calculate for math, hash_text for hashing, base64 for encoding, process_json for JSON queries,
regex for pattern matching, csv for CSV operations, validate for data validation, and diff for comparing texts.
Be precise and show results clearly.`,
    tools: [calc, hash, base64, json, regex, csv, validation, diff, slug, datetime],
    temperature: 0.2,
    maxIterations: 15,
  });

  const result1 = await cog.run(dataAgent, {
    input: `I have this JSON data: {"users": [{"name": "Alice", "age": 30}, {"name": "Bob", "age": 25}]}
Please:
1. Parse it and tell me how many users there are
2. Calculate the average age
3. Hash the string "Alice" with sha256`,
  });
  console.log('  Output:', result1.output);
  console.log('  Tools used:', result1.toolCalls.map((tc) => tc.name).join(', '));

  section('6. Validation and encoding pipeline');

  const result2 = await cog.run(dataAgent, {
    input: `Validate these values:
- "user@example.com" as email
- "https://cogitator.ai" as url
- "not-a-uuid" as uuid
Then base64-encode the valid email address.`,
  });
  console.log('  Output:', result2.output);
  console.log('  Tools used:', result2.toolCalls.map((tc) => tc.name).join(', '));

  section('7. Text diffing');

  const result3 = await cog.run(dataAgent, {
    input: `Compare these two texts:
Original: "The quick brown fox jumps over the lazy dog"
Modified: "The quick red fox leaps over the sleepy dog"
Show me the differences.`,
  });
  console.log('  Output:', result3.output);
  console.log('  Tools used:', result3.toolCalls.map((tc) => tc.name).join(', '));

  section('8. Tool call summary');

  const allResults = [result1, result2, result3];
  const allCalls = allResults.flatMap((r) => r.toolCalls);
  const toolUsage = allCalls.reduce<Record<string, number>>((acc, tc) => {
    acc[tc.name] = (acc[tc.name] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`  Total tool calls: ${allCalls.length}`);
  for (const [name, count] of Object.entries(toolUsage).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${name}: ${count}`);
  }

  const totalTokens = allResults.reduce((sum, r) => sum + r.usage.totalTokens, 0);
  console.log(`  Total tokens: ${totalTokens}`);

  await cog.close();
  console.log('\nDone.');
}

main();
