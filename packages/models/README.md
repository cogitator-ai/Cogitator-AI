# @cogitator/models

Dynamic model registry with pricing information for Cogitator. Fetches up-to-date model data from LiteLLM.

## Installation

```bash
pnpm add @cogitator/models
```

## Usage

### Get Model Information

```typescript
import { getModel, getPrice, listModels } from '@cogitator/models';

// Get model details
const model = await getModel('gpt-4o');
console.log(model.contextWindow); // 128000

// Get pricing
const price = await getPrice('claude-sonnet-4-20250514');
console.log(price.inputPerMillion);  // $3.00
console.log(price.outputPerMillion); // $15.00

// List all models
const models = await listModels({
  provider: 'openai',
  hasToolCalling: true,
});
```

### Built-in Providers

- **OpenAI**: GPT-4o, GPT-4o Mini, o1, o3-mini
- **Anthropic**: Claude Sonnet 4, Claude 3.5 Sonnet/Haiku, Claude 3 Opus
- **Google**: Gemini 2.5 Pro/Flash, Gemini 2.0 Flash, Gemini 1.5 Pro/Flash

### Caching

Model data is cached for 24 hours with automatic refresh:

```typescript
import { ModelRegistry } from '@cogitator/models';

const registry = new ModelRegistry({
  cacheTtl: 3600 * 1000, // 1 hour
  cacheDir: './cache',
});
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
