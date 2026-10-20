import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchLiteLLMData, isPriced } from '../src/fetcher';
import type { LiteLLMModelData, LiteLLMModelEntry } from '../src/types';

/**
 * Refreshes `src/data/litellm-snapshot.json`, the copy of the LiteLLM catalogue the registry
 * prices models from when it cannot fetch the catalogue. Copies the catalogue at the commit
 * `main` is at, keeps the priced models that answer text and the fields the registry reads,
 * checked for their types, with the catalogue's MIT license, one model per line so a refresh
 * reads as a diff. Run with `pnpm --filter @cogitator-ai/models snapshot`.
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

const NUMBER_FIELDS = new Set<string>([
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
]);

const BOOLEAN_FIELDS = new Set<string>([
  'supports_function_calling',
  'supports_tool_choice',
  'supports_vision',
  'supports_response_schema',
]);

/** A field value of the type the registry reads, or `undefined` for anything else. */
function checked(field: string, value: unknown): unknown {
  if (NUMBER_FIELDS.has(field)) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (BOOLEAN_FIELDS.has(field)) return typeof value === 'boolean' ? value : undefined;
  return typeof value === 'string' ? value : undefined;
}

function trim(data: LiteLLMModelData): LiteLLMModelData {
  const models: LiteLLMModelData = {};
  for (const id of Object.keys(data).sort()) {
    const entry = data[id];
    if (
      id === 'sample_spec' ||
      !entry ||
      typeof entry.mode !== 'string' ||
      !MODES.has(entry.mode)
    ) {
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const value = checked(field, entry[field]);
      if (value !== undefined) kept[field] = value;
    }
    if (isPriced(kept as LiteLLMModelEntry)) models[id] = kept as LiteLLMModelEntry;
  }
  return models;
}

/** The commit `main` of the LiteLLM repository is at, so the snapshot names the exact catalogue it copies. */
async function latestCommit(): Promise<string> {
  const response = await fetch('https://api.github.com/repos/BerriAI/litellm/commits/main', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cogitator' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the LiteLLM commit`);
  const { sha } = (await response.json()) as { sha?: unknown };
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('GitHub gave no commit for LiteLLM main');
  }
  return sha;
}

const commit = await latestCommit();
const source = `https://raw.githubusercontent.com/BerriAI/litellm/${commit}/model_prices_and_context_window.json`;
const models = trim(await fetchLiteLLMData(source));
const header = {
  source,
  license: LICENSE,
  fetchedAt: new Date().toISOString().slice(0, 10),
};
const lines = Object.entries(models).map(
  ([id, entry]) => `${JSON.stringify(id)}:${JSON.stringify(entry)}`
);
const target = fileURLToPath(new URL('../src/data/litellm-snapshot.json', import.meta.url));
writeFileSync(
  target,
  `${JSON.stringify(header).slice(0, -1)},"models":{\n${lines.join(',\n')}\n}}\n`
);
console.log(`Wrote ${lines.length} models from LiteLLM ${commit.slice(0, 12)} to ${target}`);
