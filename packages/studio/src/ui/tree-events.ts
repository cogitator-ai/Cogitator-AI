import type { TreeEntry } from '../protocol.js';

const EVENT_LABEL: Record<string, string> = {
  model_change: 'Model change',
  compaction: 'Compaction',
  approval: 'Paused for approval',
  interrupt: 'Interrupted',
  label: 'Label',
  custom: 'Event',
};

/** An `interrupt` entry pauses a run on questions its tools asked, resumes it with the answers, or records an abort */
const INTERRUPT_LABEL: Record<string, string> = {
  paused: 'Waiting for an answer',
  resumed: 'Answered',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function texts(items: unknown, key: string): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => record(item)[key])
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

/** What an event entry is called, `undefined` for a message or a tool result. */
export function eventLabel(entry: TreeEntry): string | undefined {
  if (entry.type === 'interrupt') {
    const status = record(entry.event).status;
    if (typeof status === 'string' && Object.hasOwn(INTERRUPT_LABEL, status)) {
      return INTERRUPT_LABEL[status];
    }
  }
  return Object.hasOwn(EVENT_LABEL, entry.type) ? EVENT_LABEL[entry.type] : undefined;
}

/** What an event entry says, in a line. */
export function eventText(entry: TreeEntry): string {
  const event = record(entry.event);
  if (entry.type === 'model_change' && typeof event.to === 'string') {
    return typeof event.from === 'string' ? `${event.from} → ${event.to}` : event.to;
  }
  if (entry.type === 'approval' && Array.isArray(event.pending)) {
    return texts(event.pending, 'toolName').join(', ');
  }
  if (entry.type === 'interrupt' && event.status === 'paused') {
    const questions = texts(event.interrupts, 'message');
    if (questions.length > 0) return questions.join(' · ');
  }
  if (entry.type === 'interrupt' && event.status === 'resumed') {
    const reasons = texts(event.interrupts, 'reason');
    if (reasons.length > 0) return reasons.join(', ');
  }
  return entry.text;
}
