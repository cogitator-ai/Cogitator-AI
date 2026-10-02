import { nanoid } from 'nanoid';
import type { Span, MessageContent } from '@cogitator-ai/types';

export function createSpan(
  name: string,
  traceId: string,
  parentId: string | undefined,
  startTime: number,
  endTime: number,
  attributes: Record<string, unknown>,
  status: 'ok' | 'error' | 'unset' = 'ok',
  kind: Span['kind'] = 'internal',
  onSpan?: (span: Span) => void,
  id: string = `span_${nanoid(12)}`
): Span {
  const span: Span = {
    id,
    traceId,
    parentId,
    name,
    kind,
    status,
    startTime,
    endTime,
    duration: endTime - startTime,
    attributes,
  };
  onSpan?.(span);
  return span;
}

export function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}
