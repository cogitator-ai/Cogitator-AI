# @cogitator-ai/config

Configuration loading for Cogitator. Supports YAML files, environment variables, and programmatic overrides.

## Installation

```bash
pnpm add @cogitator-ai/config
```

## Usage

### YAML Configuration

Create `cogitator.yml`:

```yaml
defaultModel: ollama/llama3.2:3b
memory:
  adapter: redis
  redis:
    url: redis://localhost:6379
logging:
  level: info
  format: json
```

### Load Configuration

```typescript
import { loadConfig } from '@cogitator-ai/config';

const config = await loadConfig({
  configPath: './cogitator.yml',
  overrides: {
    logging: { level: 'debug' },
  },
});
```

### Environment Variables

Environment variables with `COGITATOR_` prefix are automatically loaded:

```bash
COGITATOR_DEFAULT_MODEL=openai/gpt-4o
COGITATOR_LOGGING_LEVEL=debug
```

### Priority Order

1. Programmatic overrides (highest)
2. Environment variables
3. YAML config file
4. Defaults (lowest)

## Schema Validation

Configuration is validated using Zod schemas:

```typescript
import { configSchema } from '@cogitator-ai/config';

const result = configSchema.safeParse(rawConfig);
if (!result.success) {
  console.error(result.error.issues);
}
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
