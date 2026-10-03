import type { A2AStreamEvent } from '../types.js';
import { clientErrorMessage } from '../errors.js';

export function buildSseErrorEvent(error: unknown): A2AStreamEvent {
  const message = clientErrorMessage(error, 'A2A stream failed');
  const timestamp = new Date().toISOString();
  return {
    type: 'status-update',
    taskId: '',
    status: { state: 'failed', timestamp, message },
    timestamp,
  };
}
