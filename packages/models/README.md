# @cogitator-ai/models

Dynamic model registry with pricing information for Cogitator. Fetches up-to-date model data from LiteLLM and provides built-in fallbacks for major providers.

## Installation

```bash
pnpm add @cogitator-ai/models
```

## Features

- **Dynamic Data** - Fetches latest model info from LiteLLM
- **Pricing Information** - Input/output costs per million tokens
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

const model = getModel('gpt-4o');
console.log(model?.contextWindow);
console.log(model?.capabilities?.supportsVision);

const price = getPrice('claude-sonnet-4-5-20250929');
console.log(`Input: $${price?.input}/M tokens`);
console.log(`Output: $${price?.output}/M tokens`);

const toolModels = listModels({
  supportsTools: true,
  provider: 'openai',
});
```

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

| Option              | Default    | Description                          |
| ------------------- | ---------- | ------------------------------------ |
| `cache.ttl`         | 24 hours   | Cache time-to-live in milliseconds   |
| `cache.storage`     | `'memory'` | Storage backend                      |
| `cache.filePath`    | -          | File path for file-based cache       |
| `autoRefresh`       | `false`    | Enable automatic background refresh  |
| `refreshInterval`   | 24 hours   | Refresh interval in milliseconds     |
| `fallbackToBuiltin` | `true`     | Use built-in models on fetch failure |

### Registry Methods

```typescript
await registry.initialize();

const model = registry.getModel('gpt-4o');

const price = registry.getPrice('claude-sonnet-4-5-20250929');

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

For convenience, the package provides global functions that use a default registry:

```typescript
import {
  initializeModels,
  getModel,
  getPrice,
  listModels,
  getModelRegistry,
  shutdownModels,
} from '@cogitator-ai/models';

await initializeModels();

const model = getModel('gpt-4o-mini');
const price = getPrice('gpt-4o-mini');
const allModels = listModels();

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
  input: number;
  output: number;
  inputCached?: number;
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
const model = getModel('gpt-4o');
// {
//   id: 'gpt-4o',
//   provider: 'openai',
//   displayName: 'GPT-4o',
//   pricing: { input: 2.5, output: 10 },
//   contextWindow: 128000,
//   maxOutputTokens: 16384,
//   capabilities: {
//     supportsVision: true,
//     supportsTools: true,
//     supportsStreaming: true,
//     supportsJson: true,
//   }
// }
```

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

### OpenAI Models

- gpt-4.1, gpt-4.1-mini, gpt-4.1-nano
- gpt-4o, gpt-4o-mini
- o3, o3-mini, o3-pro, o4-mini

### Anthropic Models

- claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5
- claude-opus-4-1, claude-sonnet-4, claude-opus-4

### Google Models

- gemini-3-pro-preview, gemini-3-flash-preview
- gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite

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
import { ModelCache } from '@cogitator-ai/models';

const cache = new ModelCache({
  ttl: 3600000,
  storage: 'file',
  filePath: './models-cache.json',
});

const models = await cache.get();

await cache.set(models);

const staleData = await cache.getStale();
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
  litellm_provider?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  deprecation_date?: string;
}
```

---

## Examples

### Cost Calculator

```typescript
import { getPrice } from '@cogitator-ai/models';

function calculateCost(modelId: string, inputTokens: number, outputTokens: number): number | null {
  const price = getPrice(modelId);
  if (!price) return null;

  const inputCost = (inputTokens / 1_000_000) * price.input;
  const outputCost = (outputTokens / 1_000_000) * price.output;

  return inputCost + outputCost;
}

const cost = calculateCost('gpt-4o', 10000, 2000);
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
