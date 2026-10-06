import type { LLMProvider } from './llm';

const BUILTIN_PROVIDERS: Readonly<Record<LLMProvider, true>> = {
  ollama: true,
  openai: true,
  anthropic: true,
  google: true,
  azure: true,
  bedrock: true,
  vllm: true,
  mistral: true,
  groq: true,
  together: true,
  deepseek: true,
};

/** Whether `name` is a provider built into Cogitator. */
export function isLLMProvider(name: string): name is LLMProvider {
  return Object.hasOwn(BUILTIN_PROVIDERS, name);
}

/** Every provider built into Cogitator. */
export const LLM_PROVIDERS: readonly LLMProvider[] =
  Object.keys(BUILTIN_PROVIDERS).filter(isLLMProvider);

export interface ModelRouteOptions {
  /** Provider for model strings without a known `provider/` prefix, Ollama when unset */
  defaultProvider?: string;
  /** Whether a prefix names a provider, built-in providers only when unset */
  knowsProvider?: (name: string) => boolean;
}

/**
 * The provider a model string runs on, and the model name to send it.
 *
 * `provider/model` picks `provider` when it is known, and the prefix is
 * stripped. Anything else, such as `meta-llama/Llama-3.3-70B-Instruct-Turbo`
 * on Together, runs on the default provider with the whole string.
 */
export function resolveModelRoute(
  modelString: string,
  options: ModelRouteOptions = {}
): { provider: string; model: string } {
  const knows = options.knowsProvider ?? isLLMProvider;
  const slash = modelString.indexOf('/');
  if (slash > 0) {
    const prefix = modelString.slice(0, slash);
    if (knows(prefix)) return { provider: prefix, model: modelString.slice(slash + 1) };
  }
  return { provider: options.defaultProvider ?? 'ollama', model: modelString };
}
