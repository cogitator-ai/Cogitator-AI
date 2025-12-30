import { describe, it, expect } from 'vitest';
import { uuid } from '../tools/uuid';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('uuid tool', () => {
  it('generates a single UUID by default', async () => {
    const result = await uuid.execute({}, mockContext);
    expect(result).toHaveProperty('uuid');
    expect((result as { uuid: string }).uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('generates multiple UUIDs when count is specified', async () => {
    const result = await uuid.execute({ count: 5 }, mockContext);
    expect(result).toHaveProperty('uuids');
    expect(result).toHaveProperty('count', 5);
    const uuids = (result as { uuids: string[] }).uuids;
    expect(uuids).toHaveLength(5);
    uuids.forEach((id) => {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });
  });

  it('generates unique UUIDs', async () => {
    const result = await uuid.execute({ count: 100 }, mockContext);
    const uuids = (result as { uuids: string[] }).uuids;
    const uniqueSet = new Set(uuids);
    expect(uniqueSet.size).toBe(100);
  });

  it('has correct metadata', () => {
    expect(uuid.name).toBe('uuid');
    expect(uuid.description).toContain('UUID');
    const schema = uuid.toJSON();
    expect(schema.parameters.properties).toHaveProperty('count');
  });
});
