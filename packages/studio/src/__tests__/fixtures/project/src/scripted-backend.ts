import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Message,
  ToolCall,
} from '@cogitator-ai/types';

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function text(message: Message | undefined): string {
  if (!message) return '';
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** What the scripted model answers: a tool call for some words, an echo otherwise. */
function decide(request: ChatRequest): {
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
} {
  const last = request.messages.at(-1);
  if (last?.role === 'tool') {
    const raw = text(last);
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      result = raw;
    }
    return { content: `Done: ${typeof result === 'string' ? result : JSON.stringify(result)}` };
  }
  const input = text([...request.messages].reverse().find((message) => message.role === 'user'));
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: `call_${name}_${request.messages.length}`,
    name,
    arguments: args,
  });
  if (input.includes('weather'))
    return { content: '', toolCalls: [call('lookup_weather', { city: 'Lisbon' })] };
  if (input.includes('publish'))
    return { content: '', toolCalls: [call('publish', { title: 'Hello' })] };
  if (input.includes('research'))
    return { content: '', toolCalls: [call('researcher', { task: 'find facts' })] };
  const turns = request.messages.filter((message) => message.role === 'user').length;
  return { content: `Echo: ${input} (turn ${turns})`, reasoning: 'Thinking about it' };
}

/** A model for tests: deterministic, streaming, with tool calls and reasoning. */
export const scripted: LLMBackend = {
  provider: 'openai',
  async chat(request) {
    const answer = decide(request);
    const response: ChatResponse = {
      id: 'scripted',
      content: answer.content,
      ...(answer.toolCalls && { toolCalls: answer.toolCalls }),
      ...(answer.reasoning && { reasoning: answer.reasoning }),
      finishReason: answer.toolCalls ? 'tool_calls' : 'stop',
      usage: USAGE,
    };
    return response;
  },
  async *chatStream(request): AsyncGenerator<ChatStreamChunk> {
    const answer = decide(request);
    if (answer.reasoning) yield { id: 'scripted', delta: { reasoning: answer.reasoning } };
    for (const word of answer.content.split(/(?<= )/)) {
      if (word) yield { id: 'scripted', delta: { content: word } };
    }
    if (answer.toolCalls) yield { id: 'scripted', delta: { toolCalls: answer.toolCalls } };
    yield {
      id: 'scripted',
      delta: {},
      finishReason: answer.toolCalls ? 'tool_calls' : 'stop',
      usage: USAGE,
    };
  },
};
