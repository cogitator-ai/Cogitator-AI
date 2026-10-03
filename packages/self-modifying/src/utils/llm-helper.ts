import type { LLMBackend, Message } from '@cogitator-ai/types';

export async function llmChat(
  llm: LLMBackend,
  messages: Message[],
  options: { model: string; temperature?: number; maxTokens?: number }
): Promise<string> {
  if (llm.complete) {
    const response = await llm.complete({
      messages,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    return response.content;
  }

  const response = await llm.chat({
    model: options.model,
    messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  return response.content;
}

/**
 * The model a component calls its LLM with. A component that has an LLM must be
 * told which model to ask for: backends do not share a default name.
 */
export function requireModelForLLM(
  llm: LLMBackend | undefined,
  model: string | undefined,
  component: string
): string {
  if (llm && !model) {
    throw new Error(`${component} needs a model to call its LLM: pass options.model`);
  }
  return model ?? '';
}
