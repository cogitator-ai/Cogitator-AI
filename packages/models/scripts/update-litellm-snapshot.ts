import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchLiteLLMData, LITELLM_URL } from '../src/fetcher';
import type { LiteLLMModelData, LiteLLMModelEntry } from '../src/types';

/**
 * Refreshes `src/data/litellm-snapshot.json`, the copy of the LiteLLM catalogue the registry
 * prices models from when it cannot fetch the catalogue. Keeps the models that answer text and
 * the fields the registry reads. Run with `pnpm --filter @cogitator-ai/models snapshot`.
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

function trim(data: LiteLLMModelData): LiteLLMModelData {
  const models: LiteLLMModelData = {};
  for (const id of Object.keys(data).sort()) {
    const entry = data[id];
    if (id === 'sample_spec' || !entry?.mode || !MODES.has(entry.mode)) continue;
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
  license: 'MIT, Copyright (c) 2023 Berri AI',
  fetchedAt: new Date().toISOString().slice(0, 10),
  models,
};
const target = fileURLToPath(new URL('../src/data/litellm-snapshot.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(snapshot)}\n`);
console.log(`Wrote ${Object.keys(models).length} models to ${target}`);
