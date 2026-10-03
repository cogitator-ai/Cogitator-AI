# @cogitator-ai/models

Dynamic model registry with pricing information for Cogitator. Fetches up-to-date model data from LiteLLM and provides built-in fallbacks for major providers.

## Installation

```bash
pnpm add @cogitator-ai/models
```

`@cogitator-ai/core` uses this registry to price runs (`result.usage.cost`) and to pick models for cost-aware routing. See [Model Registry](https://cogitator.app/docs/core/model-registry) on the website.

## Features

- **Dynamic Data** - Fetches latest model info from LiteLLM
- **Pricing Information** - Input, output and prompt-cache costs per million tokens; `calculateCost()` prices token usage
- **Capability Tracking** - Vision, tools, streaming, JSON mode support
- **Multi-Provider** - OpenAI, Anthropic, Google, Ollama, Azure, AWS, and more
- **Caching** - Memory or file-based cache with configurable TTL
- **Fallback** - Built-in models when external data unavailable
- **Filtering** - Query models by provider, capabilities, price

---

## Quick Start

```typescript
import { initializeModels, getModel, getPrice, listModels } from '@cogitator-ai/models';

await initializeModels();

const model = getModel('gpt-6.1-sol');
console.log(model?.contextWindow);
console.log(model?.capabilities?.supportsVision);

const price = getPrice('claude-sonnet-5-5');
console.log(`Input: $${price?.input}/M tokens`);
console.log(`Output: $${price?.output}/M tokens`);

const toolModels = listModels({
  supportsTools: true,
  provider: 'openai',
});
```

Lookups are case-insensitive, accept a `provider/` prefix (`getModel('openai/gpt-6.1-sol')`) and resolve aliases. Calling them before `initializeModels()` works too: the registry then loads the built-in models only.

---

## Model Registry

The `ModelRegistry` class manages model data with caching and auto-refresh.

### Initialization

```typescript
import { ModelRegistry } from '@cogitator-ai/models';

const registry = new ModelRegistry({
  cache: {
    ttl: 24 * 60 * 60 * 1000,
    storage: 'file',
    filePath: './cache/models.json',
  },
  autoRefresh: true,
  refreshInterval: 24 * 60 * 60 * 1000,
  fallbackToBuiltin: true,
});

await registry.initialize();
```

### Configuration Options

```typescript
interface RegistryOptions {
  cache?: CacheOptions;
  autoRefresh?: boolean;
  refreshInterval?: number;
  fallbackToBuiltin?: boolean;
}

interface CacheOptions {
  ttl: number;
  storage: 'memory' | 'file';
  filePath?: string;
}
```

| Option              | Default                          | Description                          |
| ------------------- | -------------------------------- | ------------------------------------ |
| `cache.ttl`         | 24 hours                         | Cache time-to-live in milliseconds   |
| `cache.storage`     | `'memory'`                       | Storage backend                      |
| `cache.filePath`    | `~/.cogitator/models-cache.json` | File path for file-based cache       |
| `autoRefresh`       | `false`                          | Enable automatic background refresh  |
| `refreshInterval`   | 24 hours                         | Refresh interval in milliseconds     |
| `fallbackToBuiltin` | `true`                           | Use built-in models on fetch failure |

`initialize()` uses a fresh cache when there is one (and refreshes from LiteLLM in the background), otherwise fetches LiteLLM data; fetched models are merged with the built-in ones. When the fetch fails it falls back to a stale cache, then to the built-in models (or throws with `fallbackToBuiltin: false`).

### Registry Methods

```typescript
await registry.initialize();

const model = registry.getModel('gpt-6.1-sol');

const price = registry.getPrice('claude-sonnet-5-5'); // { input, output } per million tokens
const pricing = registry.getPricing('claude-sonnet-5-5'); // full ModelPricing incl. cache prices

const models = registry.listModels({
  provider: 'anthropic',
  supportsVision: true,
});

const providers = registry.listProviders();

const provider = registry.getProvider('openai');

console.log(registry.getModelCount());
console.log(registry.isInitialized());

await registry.refresh();

registry.shutdown();
```

---

## Global Functions

For convenience, the package provides global functions that use a default registry (file cache at `~/.cogitator/models-cache.json`, 24 h TTL, built-in fallback):

```typescript
import {
  initializeModels,
  getModel,
  getPrice,
  getPricing,
  calculateCost,
  listModels,
  getModelRegistry,
  shutdownModels,
} from '@cogitator-ai/models';

await initializeModels();

const model = getModel('gpt-6.1-sol');
const price = getPrice('gpt-6.1-sol');
const pricing = getPricing('gpt-6.1-sol');
const allModels = listModels();

// USD for a call; cached and cache-write tokens are parts of inputTokens
const cost = calculateCost('claude-sonnet-5-5', {
  inputTokens: 12_000,
  outputTokens: 800,
  cachedInputTokens: 10_000,
  cacheWriteTokens: 0,
}); // null when the model's price is unknown

const registry = getModelRegistry();
const count = registry.getModelCount();

shutdownModels();
```

---

## Model Information

### ModelInfo Type

```typescript
interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  pricing: ModelPricing;
  contextWindow: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  deprecated?: boolean;
  aliases?: string[];
}

interface ModelPricing {
  input: number; // USD per million input tokens
  output: number; // USD per million output tokens
  inputCached?: number; // cache reads
  inputCacheWrite?: number; // cache writes
  outputCached?: number;
}

interface ModelCapabilities {
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsFunctions?: boolean;
  supportsStreaming?: boolean;
  supportsJson?: boolean;
}
```

### Example Model

```typescript
const model = getModel('gpt-6.1-sol');
// {
//   id: 'gpt-6.1-sol',
//   provider: 'openai',
//   displayName: 'GPT-6.1 Sol',
//   pricing: { input: 2, output: 10, inputCached: 0.1 },
//   contextWindow: 1050000,
//   maxOutputTokens: 128000,
//   capabilities: {
//     supportsTools: true,
//     supportsVision: true,
//     supportsFunctions: true,
//     supportsStreaming: true,
//     supportsJson: true,
//   }
// }
```

Values shown are the built-in fallback entry; after `initializeModels()` the data may come from LiteLLM instead.

---

## Filtering Models

Use `ModelFilter` to query specific models:

```typescript
interface ModelFilter {
  provider?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  minContextWindow?: number;
  maxPricePerMillion?: number;
  excludeDeprecated?: boolean;
}
```

`supportsTools` and `supportsVision` accept both `true` and `false` (a model without the capability flag counts as `false`). `maxPricePerMillion` compares the average of the input and output price.

### Filter Examples

```typescript
const openaiModels = listModels({
  provider: 'openai',
});

const visionModels = listModels({
  supportsVision: true,
});

const toolModels = listModels({
  supportsTools: true,
  excludeDeprecated: true,
});

const largeContext = listModels({
  minContextWindow: 100000,
});

const cheapModels = listModels({
  maxPricePerMillion: 1.0,
});

const anthropicVision = listModels({
  provider: 'anthropic',
  supportsVision: true,
  supportsTools: true,
});
```

---

## Providers

### Built-in Providers

```typescript
import { BUILTIN_PROVIDERS } from '@cogitator-ai/models';
```

| Provider     | Website                |
| ------------ | ---------------------- |
| OpenAI       | openai.com             |
| Anthropic    | anthropic.com          |
| Google       | ai.google.dev          |
| Ollama       | ollama.com             |
| Azure OpenAI | azure.microsoft.com    |
| AWS Bedrock  | aws.amazon.com/bedrock |
| Mistral AI   | mistral.ai             |
| Cohere       | cohere.com             |
| Groq         | groq.com               |
| Together AI  | together.ai            |
| Fireworks AI | fireworks.ai           |
| DeepInfra    | deepinfra.com          |
| Perplexity   | perplexity.ai          |
| Replicate    | replicate.com          |
| xAI          | x.ai                   |

### Provider Information

```typescript
interface ProviderInfo {
  id: string;
  name: string;
  website?: string;
  models: string[];
}

const providers = registry.listProviders();
const openai = registry.getProvider('openai');
console.log(openai?.models.length);
```

---

## Built-in Models

Fallback models are available when LiteLLM data cannot be fetched:

```typescript
import {
  BUILTIN_MODELS,
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GOOGLE_MODELS,
} from '@cogitator-ai/models';
```

Deprecated entries stay in the registry (with `deprecated: true`) so pricing and lookups keep working for existing configs; use `excludeDeprecated: true` to hide them.

### OpenAI Models

- gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna
- gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna
- gpt-5.5, gpt-5.5-pro
- gpt-5.4, gpt-5.4-mini, gpt-5.4-pro
- gpt-4.1, gpt-4.1-mini
- gpt-4o, gpt-4o-mini
- Deprecated: gpt-5.4-nano, gpt-4.1-nano, o3, o3-mini, o3-pro, o4-mini, o1, o1-mini, o1-preview, gpt-4-turbo, gpt-4, gpt-3.5-turbo

### Anthropic Models

- claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5
- claude-opus-5, claude-sonnet-5, claude-fable-5
- claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6
- claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5
- Deprecated: claude-opus-4-1, claude-sonnet-4, claude-opus-4, claude-3-7-sonnet, claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus, claude-3-haiku

### Google Models

- gemini-3.8-flash, gemini-3.5-flash-lite, gemini-3.5-flash
- gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-3.1-flash-lite
- Deprecated: gemini-3.1-flash-lite-preview, gemini-3-pro-preview, gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash, gemini-2.0-flash-lite, gemini-1.5-pro, gemini-1.5-flash, gemini-1.5-flash-8b

Aliases resolve to the canonical id, for example `gemini-flash` / `gemini-3-flash` → `gemini-3.8-flash`, `gemini-flash-lite` / `gemini-3-flash-lite` → `gemini-3.5-flash-lite`, `claude-sonnet-5.5` → `claude-sonnet-5-5`.

---

## Caching

### Memory Cache

```typescript
const registry = new ModelRegistry({
  cache: {
    ttl: 60 * 60 * 1000,
    storage: 'memory',
  },
});
```

### File Cache

```typescript
const registry = new ModelRegistry({
  cache: {
    ttl: 24 * 60 * 60 * 1000,
    storage: 'file',
    filePath: './cache/models.json',
  },
});
```

### ModelCache Class

```typescript
import { BUILTIN_MODELS, ModelCache } from '@cogitator-ai/models';

const cache = new ModelCache({
  ttl: 3600000,
  storage: 'file',
  filePath: './models-cache.json',
});

const models = await cache.get(); // null when missing or older than ttl

await cache.set(BUILTIN_MODELS);

const staleData = await cache.getStale(); // ignores the TTL

await cache.clear();
```

---

## Data Fetching

### LiteLLM Integration

```typescript
import { fetchLiteLLMData, transformLiteLLMData } from '@cogitator-ai/models';

const rawData = await fetchLiteLLMData();

const models = transformLiteLLMData(rawData);
```

### LiteLLM Data Structure

```typescript
interface LiteLLMModelEntry {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_response_schema?: boolean;
  supports_tool_choice?: boolean;
  deprecation_date?: string;
  // ...and a few more LiteLLM fields
}
```

---

## Examples

### Cost Calculator

```typescript
import { calculateCost } from '@cogitator-ai/models';

const cost = calculateCost('gpt-6.1-sol', { inputTokens: 10_000, outputTokens: 2_000 });
console.log(`Cost: $${cost?.toFixed(4)}`);
```

### Model Selector

```typescript
import { listModels } from '@cogitator-ai/models';

function selectBestModel(options: {
  needsVision?: boolean;
  needsTools?: boolean;
  maxCost?: number;
  minContext?: number;
}): string | null {
  const models = listModels({
    supportsVision: options.needsVision,
    supportsTools: options.needsTools,
    maxPricePerMillion: options.maxCost,
    minContextWindow: options.minContext,
    excludeDeprecated: true,
  });

  if (models.length === 0) return null;

  models.sort((a, b) => {
    const aPrice = (a.pricing.input + a.pricing.output) / 2;
    const bPrice = (b.pricing.input + b.pricing.output) / 2;
    return aPrice - bPrice;
  });

  return models[0].id;
}

const cheapTool = selectBestModel({
  needsTools: true,
  maxCost: 2.0,
});
```

### Provider Dashboard

```typescript
import { getModelRegistry, initializeModels } from '@cogitator-ai/models';

async function showDashboard() {
  await initializeModels();
  const registry = getModelRegistry();

  console.log(`Total models: ${registry.getModelCount()}`);
  console.log();

  for (const provider of registry.listProviders()) {
    const models = registry.listModels({ provider: provider.id });
    console.log(`${provider.name}: ${models.length} models`);

    const avgPrice =
      models.reduce((sum, m) => sum + (m.pricing.input + m.pricing.output) / 2, 0) / models.length;
    console.log(`  Avg price: $${avgPrice.toFixed(2)}/M tokens`);
  }
}
```

---

## Type Reference

```typescript
import type {
  ModelInfo,
  ModelPricing,
  ModelCapabilities,
  ModelFilter,
  ProviderInfo,
  CacheOptions,
  RegistryOptions,
  LiteLLMModelEntry,
  LiteLLMModelData,
  TokenUsageForCost,
} from '@cogitator-ai/models';

import {
  ModelInfoSchema,
  ModelPricingSchema,
  ModelCapabilitiesSchema,
  ProviderInfoSchema,
} from '@cogitator-ai/models';
```

---

## License

MIT
