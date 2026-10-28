import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPENROUTER_CAPABILITY_PARAMETERS,
  OPENROUTER_MODELS_URL,
  answersInText,
  fetchOpenRouterData,
  isOpenRouterPriced,
  type OpenRouterModelEntry,
} from '../src/openrouter-catalogue';

/**
 * Refreshes `src/data/openrouter-snapshot.json`, the copy of OpenRouter's model list the registry
 * prices `openrouter/*` models from when it cannot fetch the list. Keeps the priced models that
 * answer in text and the fields the registry reads, sorted by id, one model per line so a refresh
 * reads as a diff. Run with `pnpm --filter @cogitator-ai/models snapshot`.
 */

function trim(entry: OpenRouterModelEntry): OpenRouterModelEntry {
  const parameters = entry.supported_parameters?.filter((parameter) =>
    OPENROUTER_CAPABILITY_PARAMETERS.includes(parameter)
  );
  const { pricing, architecture, top_provider: top } = entry;
  return {
    id: entry.id,
    ...(entry.name !== undefined && { name: entry.name }),
    ...(typeof entry.context_length === 'number' && { context_length: entry.context_length }),
    ...(architecture && {
      architecture: {
        ...(architecture.input_modalities && { input_modalities: architecture.input_modalities }),
        ...(architecture.output_modalities && {
          output_modalities: architecture.output_modalities,
        }),
      },
    }),
    pricing: {
      prompt: pricing.prompt,
      completion: pricing.completion,
      ...(pricing.input_cache_read !== undefined && { input_cache_read: pricing.input_cache_read }),
      ...(pricing.input_cache_write !== undefined && {
        input_cache_write: pricing.input_cache_write,
      }),
      ...(pricing.input_cache_write_1h !== undefined && {
        input_cache_write_1h: pricing.input_cache_write_1h,
      }),
    },
    ...(top && {
      top_provider: {
        ...(typeof top.context_length === 'number' && { context_length: top.context_length }),
        ...(typeof top.max_completion_tokens === 'number' && {
          max_completion_tokens: top.max_completion_tokens,
        }),
      },
    }),
    ...(parameters && { supported_parameters: parameters }),
    ...(entry.expiration_date && { expiration_date: entry.expiration_date }),
  };
}

const models = (await fetchOpenRouterData())
  .filter((entry) => answersInText(entry) && isOpenRouterPriced(entry))
  .map(trim)
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const header = {
  source: OPENROUTER_MODELS_URL,
  fetchedAt: new Date().toISOString().slice(0, 10),
};
const lines = models.map((entry) => JSON.stringify(entry));
const target = fileURLToPath(new URL('../src/data/openrouter-snapshot.json', import.meta.url));
writeFileSync(
  target,
  `${JSON.stringify(header).slice(0, -1)},"models":[\n${lines.join(',\n')}\n]}\n`
);
console.log(`Wrote ${lines.length} models from OpenRouter to ${target}`);
