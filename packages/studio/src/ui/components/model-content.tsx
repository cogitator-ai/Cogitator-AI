import { JsonBlock } from './common';
import { Markdown } from './markdown';

/** A part of a message in the OpenTelemetry GenAI shape the runtime records content in. */
type Part =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id?: string | null; name: string; arguments?: unknown }
  | { type: 'tool_call_response'; id?: string | null; response?: unknown }
  | { type: string; [key: string]: unknown };

interface Message {
  role: string;
  parts: Part[];
  name?: string;
  finish_reason?: string;
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isPart(value: unknown): value is Part {
  return typeof value === 'object' && value !== null && typeof (value as Part).type === 'string';
}

function messagesOf(value: unknown): Message[] | undefined {
  const parsed = parse(value);
  if (!Array.isArray(parsed)) return undefined;
  return parsed
    .filter(
      (item): item is Message =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Message).role === 'string' &&
        Array.isArray((item as Message).parts)
    )
    .map((message) => ({ ...message, parts: message.parts.filter(isPart) }));
}

/** Content an attribute holds that is not in the shape `ModelContent` reads, shown as it is. */
function unreadable(value: unknown, read: unknown): value is string {
  return typeof value === 'string' && value !== '' && read === undefined;
}

function partsOf(value: unknown): Part[] | undefined {
  const parsed = parse(value);
  return Array.isArray(parsed) ? parsed.filter(isPart) : undefined;
}

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case 'text':
      return <Markdown text={String(part.content)} />;
    case 'reasoning':
      return <div className="model-reasoning">{String(part.content)}</div>;
    case 'tool_call':
      return <JsonBlock label={`call ${String(part.name)}`} value={part.arguments ?? {}} />;
    case 'tool_call_response':
      return <JsonBlock label="tool result" value={part.response ?? null} />;
    default:
      return <div className="model-part-other mono">[{part.type}]</div>;
  }
}

function MessageView({ message }: { message: Message }) {
  return (
    <div className="model-message">
      <div className="model-role">
        {message.role}
        {message.name && <span className="muted"> {message.name}</span>}
        {message.finish_reason && <span className="muted"> - {message.finish_reason}</span>}
      </div>
      {message.parts.map((part, index) => (
        <PartView key={index} part={part} />
      ))}
    </div>
  );
}

/**
 * What a model call was sent and answered, from the content attributes the runtime records for
 * the studio: the instructions, the prompt's messages and the response.
 */
export function ModelContent({ attributes }: { attributes: Record<string, unknown> }) {
  const rawInstructions = attributes['gen_ai.system_instructions'];
  const rawInput = attributes['gen_ai.input.messages'];
  const rawOutput = attributes['gen_ai.output.messages'];
  const instructions = partsOf(rawInstructions);
  const input = messagesOf(rawInput);
  const output = messagesOf(rawOutput);
  const raw = [
    ['Instructions', rawInstructions, instructions],
    ['Prompt', rawInput, input],
    ['Response', rawOutput, output],
  ] as const;
  if (
    !instructions &&
    !input &&
    !output &&
    !raw.some(([, value, read]) => unreadable(value, read))
  ) {
    return null;
  }
  return (
    <div className="model-content" data-testid="model-content">
      {raw.map(([label, value, read]) =>
        unreadable(value, read) ? <JsonBlock key={label} label={label} value={value} /> : null
      )}
      {instructions && instructions.length > 0 && (
        <div>
          <div className="io-label">Instructions</div>
          <div className="model-message">
            {instructions.map((part, index) => (
              <PartView key={index} part={part} />
            ))}
          </div>
        </div>
      )}
      {input && input.length > 0 && (
        <div>
          <div className="io-label">Prompt</div>
          {input.map((message, index) => (
            <MessageView key={index} message={message} />
          ))}
        </div>
      )}
      {output && output.length > 0 && (
        <div>
          <div className="io-label">Response</div>
          {output.map((message, index) => (
            <MessageView key={index} message={message} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The content attributes, shown by `ModelContent` instead of the raw attribute list. */
export const MODEL_CONTENT_ATTRIBUTES = [
  'gen_ai.system_instructions',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
];
