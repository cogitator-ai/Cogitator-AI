import { header, section } from '../_shared/setup.js';
import {
  initializeModels,
  getModel,
  getPrice,
  listModels,
  getModelRegistry,
  shutdownModels,
  LITELLM_SNAPSHOT,
} from '@cogitator-ai/models';

header('Model Registry');

section('Offline catalogue (no network needed)');
const gptLuna = getModel('gpt-6-luna');
console.log(
  `${gptLuna?.displayName}: ${gptLuna?.contextWindow} context, $${gptLuna?.pricing.input}/M input`
);

const claude = getModel('claude-sonnet-5-5');
console.log(
  `${claude?.displayName}: ${claude?.contextWindow} context, $${claude?.pricing.input}/M input`
);

const deepseek = getModel('deepseek/deepseek-chat');
console.log(
  `${deepseek?.id} (${deepseek?.provider}): $${deepseek?.pricing.input}/M input, from the LiteLLM copy of ${LITELLM_SNAPSHOT.fetchedAt}`
);

section('Pricing lookup');
const price = getPrice('gpt-6-luna');
if (price) {
  const inputTokens = 50_000;
  const outputTokens = 10_000;
  const cost = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  console.log(`GPT-6 Luna: ${inputTokens} in + ${outputTokens} out = $${cost.toFixed(4)}`);
}

section('Filter: cheap tool-calling models');
const cheapTools = listModels({
  supportsTools: true,
  maxPricePerMillion: 2,
  excludeDeprecated: true,
});
for (const m of cheapTools.slice(0, 5)) {
  const avg = ((m.pricing.input + m.pricing.output) / 2).toFixed(2);
  console.log(`  ${m.id} (${m.provider}) - avg $${avg}/M`);
}

section('Filter: vision models with large context');
const visionModels = listModels({
  supportsVision: true,
  minContextWindow: 200_000,
  excludeDeprecated: true,
});
console.log(`${visionModels.length} models, the first five:`);
for (const m of visionModels.slice(0, 5)) {
  console.log(`  ${m.id} - ${m.contextWindow.toLocaleString()} tokens`);
}

section('Providers with the most models');
const registry = getModelRegistry();
const providers = registry
  .listProviders()
  .map((provider) => ({
    name: provider.name,
    count: registry.listModels({ provider: provider.id }).length,
  }))
  .sort((a, b) => b.count - a.count);
console.log(`${providers.length} providers, ${registry.getModelCount()} models`);
for (const { name, count } of providers.slice(0, 8)) {
  console.log(`  ${name}: ${count} models`);
}

section('Load the current catalogue from LiteLLM');
await initializeModels();
console.log(`Models after initializeModels(): ${getModelRegistry().getModelCount()}`);
console.log('(it falls back to the offline catalogue when LiteLLM and the cache are unreachable)');

shutdownModels();
console.log('\nDone.');
