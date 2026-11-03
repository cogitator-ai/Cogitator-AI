# Testing with `@cogitator-ai/test-utils`

Runnable examples for unit-testing agents without API keys or Ollama.

## Examples

| File                                             | What it shows                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [`01-mock-llm-agent.ts`](./01-mock-llm-agent.ts) | Script `MockLLMBackend` responses, run an agent, assert tool calls and output, inspect `getCalls()` |

No environment variables are required.

```bash
npx tsx examples/testing/01-mock-llm-agent.ts
```
