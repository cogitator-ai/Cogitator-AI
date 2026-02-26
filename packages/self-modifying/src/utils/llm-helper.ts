import type { LLMBackend, Message } from '@cogitator-ai/types';

export async function llmChat(
  llm: LLMBackend,
  messages: Message[],
  options?: { temperature?: number; maxTokens?: number; model?: string }
): Promise<string> {
  if (llm.complete) {
    const response = await llm.complete({
      messages,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });
    return response.content;
  }

  const response = await llm.chat({
    model: options?.model ?? 'default',
    messages,
    temperature: options?.temperature,
    maxTokens: options?.maxTokens,
  });
  return response.content;
}
