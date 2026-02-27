import { describe, it, expect } from 'vitest';
import { createCapabilitiesTool } from '../tools/capabilities-tool';

describe('createCapabilitiesTool', () => {
  const doc = [
    '# Assistant Capabilities',
    '',
    '## Available Tools',
    '- **web_search** — Search the web',
    '- **screenshot** — Capture screen',
    '- **calculator** — Math expressions',
    '',
    '## Connected Channels',
    '- telegram',
    '',
    '## Memory',
    '- 42 entities in knowledge graph',
    '- 15 relations',
  ].join('\n');

  it('finds matching capability', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'screenshot' }, {} as never);
    expect(result.found).toBe(true);
    expect(result.matches).toContain('screenshot');
  });

  it('finds case-insensitive', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'WEB_SEARCH' }, {} as never);
    expect(result.found).toBe(true);
    expect(result.matches).toContain('web_search');
  });

  it('returns not found for missing capability', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'pizza delivery' }, {} as never);
    expect(result.found).toBe(false);
  });

  it('finds channel info', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'telegram' }, {} as never);
    expect(result.found).toBe(true);
  });

  it('finds memory stats', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'entities' }, {} as never);
    expect(result.found).toBe(true);
    expect(result.matches).toContain('42 entities');
  });

  it('returns suggestion text on match', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'calculator' }, {} as never);
    expect(result.suggestion).toContain('1 matching');
  });

  it('returns suggestion text on miss', async () => {
    const t = createCapabilitiesTool(doc);
    const result = await t.execute({ query: 'nonexistent' }, {} as never);
    expect(result.suggestion).toContain('not be available');
  });
});
