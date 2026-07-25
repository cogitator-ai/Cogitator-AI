import type { A2AStreamEvent } from '../types.js';

export function buildSseErrorEvent(error: unknown): A2AStreamEvent {
  const message = error instanceof Error ? error.message : 'Internal streaming error';
  const timestamp = new Date().toISOString();
  return {
    type: 'status-update',
    taskId: '',
    status: { state: 'failed', timestamp, message },
    timestamp,
  };
}
