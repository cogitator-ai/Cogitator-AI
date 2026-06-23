import { header, section } from '../_shared/setup.js';
import {
  initializeModels,
  getModel,
  getPrice,
  listModels,
  getModelRegistry,
  shutdownModels,
  BUILTIN_MODELS,
} from '@cogitator-ai/models';

header('Model Registry');

section('Built-in models (no network needed)');
const gpt54Mini = getModel('gpt-5.4-mini');
console.log(
  `${gpt54Mini?.displayName}: ${gpt54Mini?.contextWindow} context, $${gpt54Mini?.pricing.input}/M input`
);

const claude = getModel('claude-sonnet-4-6');
console.log(
  `${claude?.displayName}: ${claude?.contextWindow} context, $${claude?.pricing.input}/M input`
);

section('Pricing lookup');
const price = getPrice('gpt-5.4-mini');
if (price) {
  const inputTokens = 50_000;
  const outputTokens = 10_000;
  const cost = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  console.log(`GPT-5.4 Mini: ${inputTokens} in + ${outputTokens} out = $${cost.toFixed(4)}`);
}

section('Filter: cheap tool-calling models');
const cheapTools = listModels({
  supportsTools: true,
  maxPricePerMillion: 2,
  excludeDeprecated: true,
});
for (const m of cheapTools.slice(0, 5)) {
  const avg = ((m.pricing.input + m.pricing.output) / 2).toFixed(2);
  console.log(`  ${m.id} (${m.provider}) — avg $${avg}/M`);
}

section('Filter: vision models with large context');
const visionModels = listModels({
  supportsVision: true,
  minContextWindow: 200_000,
  excludeDeprecated: true,
});
for (const m of visionModels) {
  console.log(`  ${m.id} — ${m.contextWindow.toLocaleString()} tokens`);
}

section('Providers');
const registry = getModelRegistry();
for (const provider of registry.listProviders()) {
  const active = registry.listModels({ provider: provider.id }).length;
  console.log(`  ${provider.name}: ${active} models`);
}

section('Fetch latest data from LiteLLM');
try {
  await initializeModels();
  const reg = getModelRegistry();
  console.log(`Total models after fetch: ${reg.getModelCount()}`);
  console.log(`(Built-in: ${BUILTIN_MODELS.length})`);
} catch {
  console.log('Network fetch failed, using built-in data');
}

shutdownModels();
console.log('\nDone.');
