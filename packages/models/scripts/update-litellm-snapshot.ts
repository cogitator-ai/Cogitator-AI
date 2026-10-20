import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchLiteLLMData, LITELLM_URL } from '../src/fetcher';
import type { LiteLLMModelData, LiteLLMModelEntry } from '../src/types';

/**
 * Refreshes `src/data/litellm-snapshot.json`, the copy of the LiteLLM catalogue the registry
 * prices models from when it cannot fetch the catalogue. Keeps the priced models that answer
 * text and the fields the registry reads, with the catalogue's MIT license. Run with `pnpm --filter @cogitator-ai/models snapshot`.
 */

const MODES = new Set(['chat', 'completion', 'responses', 'embedding']);

const FIELDS = [
  'litellm_provider',
  'mode',
  'max_tokens',
  'max_input_tokens',
  'max_output_tokens',
  'input_cost_per_token',
  'output_cost_per_token',
  'input_cost_per_character',
  'output_cost_per_character',
  'cache_read_input_token_cost',
  'cache_creation_input_token_cost',
  'cache_creation_input_token_cost_above_1hr',
  'supports_function_calling',
  'supports_tool_choice',
  'supports_vision',
  'supports_response_schema',
  'deprecation_date',
] as const satisfies readonly (keyof LiteLLMModelEntry)[];

const LICENSE = `MIT License

Copyright (c) 2023 Berri AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** Whether the catalogue gives a price at all: an entry without one would price its model at $0. */
function isPriced(entry: LiteLLMModelEntry): boolean {
  return (
    (entry.input_cost_per_token ?? entry.input_cost_per_character) !== undefined ||
    (entry.output_cost_per_token ?? entry.output_cost_per_character) !== undefined
  );
}

function trim(data: LiteLLMModelData): LiteLLMModelData {
  const models: LiteLLMModelData = {};
  for (const id of Object.keys(data).sort()) {
    const entry = data[id];
    if (id === 'sample_spec' || !entry?.mode || !MODES.has(entry.mode) || !isPriced(entry)) {
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const field of FIELDS) {
      if (entry[field] !== undefined) kept[field] = entry[field];
    }
    models[id] = kept as LiteLLMModelEntry;
  }
  return models;
}

const models = trim(await fetchLiteLLMData());
const snapshot = {
  source: LITELLM_URL,
  license: LICENSE,
  fetchedAt: new Date().toISOString().slice(0, 10),
  models,
};
const target = fileURLToPath(new URL('../src/data/litellm-snapshot.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(snapshot)}\n`);
console.log(`Wrote ${Object.keys(models).length} models to ${target}`);
