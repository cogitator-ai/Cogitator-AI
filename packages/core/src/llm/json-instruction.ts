import type { Message } from '@cogitator-ai/types';

/**
 * Asks the model for a JSON final answer in words, for requests where the provider cannot
 * enforce the response format through its API while tools are offered.
 */
export function jsonInstruction(schema: Record<string, unknown> | undefined): string {
  return schema
    ? `When you give your final answer, respond with valid JSON only, conforming to this JSON schema:\n${JSON.stringify(schema)}`
    : 'When you give your final answer, respond with valid JSON only.';
}

/** `messages` with `instruction` appended to the first system message, or a new one in front. */
export function withSystemInstruction(messages: Message[], instruction: string): Message[] {
  const index = messages.findIndex((message) => message.role === 'system');
  if (index === -1) return [{ role: 'system', content: instruction }, ...messages];

  return messages.map((message, i) => {
    if (i !== index) return message;
    const content =
      typeof message.content === 'string'
        ? `${message.content}\n\n${instruction}`
        : [...message.content, { type: 'text' as const, text: instruction }];
    return { ...message, content };
  });
}
