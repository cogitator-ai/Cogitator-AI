import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as entry from '../server/index';
import * as root from '../index';

describe('@cogitator-ai/mcp/server', () => {
  it('exports the server of the package root, the same classes', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'InMemoryMCPTaskStore',
      'MCPServer',
      'serveMCPTools',
    ]);
    expect(entry.MCPServer).toBe(root.MCPServer);
    expect(entry.serveMCPTools).toBe(root.serveMCPTools);
    expect(entry.InMemoryMCPTaskStore).toBe(root.InMemoryMCPTaskStore);
  });

  it('is an entry of the package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    ) as { exports: Record<string, { import: string }> };
    expect(manifest.exports['./server'].import).toBe('./dist/server/index.js');
  });
});
