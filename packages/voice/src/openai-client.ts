import type OpenAI from 'openai';
import type { ClientOptions } from 'openai';

export type OpenAIClientFactory = () => Promise<OpenAI>;

/**
 * `openai` is an optional peer dependency, so it is imported on first use instead of at module
 * load. Importing `@cogitator-ai/voice` therefore works without it when only non-OpenAI
 * providers are used.
 */
export function lazyOpenAIClient(options: ClientOptions): OpenAIClientFactory {
  let client: Promise<OpenAI> | null = null;

  return () => {
    client ??= import('openai').then(
      ({ default: OpenAIClient }) => new OpenAIClient(options),
      (cause: unknown) => {
        client = null;
        throw new Error(
          "The 'openai' package is required for OpenAI voice providers. Install it with: pnpm add openai",
          { cause }
        );
      }
    );
    return client;
  };
}
