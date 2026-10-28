import type { LLMBackendProvider, ToolSchema } from '@cogitator-ai/types';

/** The providers whose tool format has a field for what a tool returns */
const NATIVE_OUTPUT_SCHEMA_PROVIDERS: ReadonlySet<LLMBackendProvider> = new Set(['google']);

/**
 * The tools of a request to `provider`, the output schema of each told the model the way
 * `mode` says: `native` leaves it to the backends that have a field for it, `description` adds
 * it to the end of the description for the other providers
 */
export function withToolOutputSchemas(
  tools: ToolSchema[] | undefined,
  provider: LLMBackendProvider,
  mode: 'native' | 'description' = 'native'
): ToolSchema[] | undefined {
  if (!tools || mode === 'native' || NATIVE_OUTPUT_SCHEMA_PROVIDERS.has(provider)) return tools;
  return tools.map((tool) =>
    tool.outputSchema
      ? {
          ...tool,
          description:
            `${tool.description}\n\nReturns JSON that matches this JSON Schema: ` +
            JSON.stringify(tool.outputSchema),
        }
      : tool
  );
}
