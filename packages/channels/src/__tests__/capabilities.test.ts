import { describe, it, expect } from 'vitest';
import { generateCapabilitiesDoc } from '../capabilities';

describe('generateCapabilitiesDoc', () => {
  it('generates markdown from tools and channels', () => {
    const doc = generateCapabilitiesDoc({
      tools: [
        { name: 'web_search', description: 'Search the web' },
        { name: 'calculator', description: 'Math' },
      ],
      channels: ['telegram', 'discord'],
      memoryStats: { entities: 42, relations: 15 },
      scheduledTasks: 3,
    });

    expect(doc).toContain('web_search');
    expect(doc).toContain('telegram');
    expect(doc).toContain('42 entities');
    expect(doc).toContain('3 active scheduled tasks');
  });

  it('handles empty inputs', () => {
    const doc = generateCapabilitiesDoc({ tools: [], channels: [] });
    expect(doc).toContain('# Assistant Capabilities');
  });

  it('omits sections with no data', () => {
    const doc = generateCapabilitiesDoc({ tools: [], channels: [] });
    expect(doc).not.toContain('Memory');
    expect(doc).not.toContain('Scheduled Tasks');
    expect(doc).not.toContain('Connected Channels');
  });

  it('includes tool descriptions', () => {
    const doc = generateCapabilitiesDoc({
      tools: [{ name: 'screenshot', description: 'Capture screen content' }],
      channels: [],
    });
    expect(doc).toContain('**screenshot** — Capture screen content');
  });

  it('includes memory stats when provided', () => {
    const doc = generateCapabilitiesDoc({
      tools: [],
      channels: [],
      memoryStats: { entities: 100, relations: 50 },
    });
    expect(doc).toContain('## Memory');
    expect(doc).toContain('100 entities in knowledge graph');
    expect(doc).toContain('50 relations');
  });
});
