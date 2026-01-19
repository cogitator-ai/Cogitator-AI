---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

feat: add structured outputs / JSON mode support

Implement responseFormat parameter across all LLM backends for guaranteed JSON output:

- **json_object**: Simple JSON mode - model returns valid JSON
- **json_schema**: Strict schema validation with name, description, and schema definition

Works with all backends:

- OpenAI: Native response_format support
- Anthropic: Tool-based JSON schema forcing
- Google: responseMimeType and responseSchema in generationConfig
- Ollama: format parameter with 'json' or schema object

```typescript
// Simple JSON mode
const result = await backend.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'List 3 colors as JSON array' }],
  responseFormat: { type: 'json_object' },
});

// Strict schema validation
const result = await backend.chat({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Extract person info' }],
  responseFormat: {
    type: 'json_schema',
    jsonSchema: {
      name: 'person',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, age: { type: 'number' } },
        required: ['name', 'age'],
      },
    },
  },
});
```
