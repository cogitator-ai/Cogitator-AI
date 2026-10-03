import { describe, it, expect } from 'vitest';
import { InMemoryAdapter, unwrap } from '../index';

describe('unwrap', () => {
  it('returns the data of a successful call', async () => {
    const memory = new InMemoryAdapter();
    await memory.connect();

    const thread = unwrap(await memory.createThread('agent-1', { topic: 'x' }));

    expect(thread.agentId).toBe('agent-1');
    expect(unwrap(await memory.getThread(thread.id))?.id).toBe(thread.id);
  });

  it('throws the error of a failed call', () => {
    expect(() => unwrap({ success: false, error: 'Not connected' })).toThrow('Not connected');
  });
});
