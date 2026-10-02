import { describe, it, expect } from 'vitest';
import { extractMcpName, parsePathList, splitCommandLine } from '../commands/wizard.js';

describe('splitCommandLine', () => {
  it('splits on whitespace', () => {
    expect(splitCommandLine('npx -y  @modelcontextprotocol/server-filesystem /home')).toEqual([
      'npx',
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/home',
    ]);
  });

  it('keeps quoted arguments together', () => {
    expect(splitCommandLine(`npx server "/Users/me/My Docs" 'single quoted'`)).toEqual([
      'npx',
      'server',
      '/Users/me/My Docs',
      'single quoted',
    ]);
  });

  it('supports escapes and empty quoted args', () => {
    expect(splitCommandLine('cmd My\\ Docs "a\\"b" ""')).toEqual(['cmd', 'My Docs', 'a"b', '']);
  });

  it('throws on unterminated quotes', () => {
    expect(() => splitCommandLine('cmd "oops')).toThrow('Unterminated quote');
  });
});

describe('extractMcpName', () => {
  it('derives names from scoped packages', () => {
    expect(extractMcpName(['-y', '@modelcontextprotocol/server-filesystem', '/home'])).toBe(
      'filesystem'
    );
    expect(extractMcpName(['-y', '@playwright/mcp@latest'])).toBe('mcp');
  });

  it('strips common prefixes/suffixes and versions', () => {
    expect(extractMcpName(['github-mcp-server@1.2.3'])).toBe('github');
    expect(extractMcpName(['mcp-server-fetch'])).toBe('fetch');
  });

  it('falls back to a generic name', () => {
    expect(extractMcpName([])).toBe('mcp-server');
    expect(extractMcpName(['--stdio'])).toBe('mcp-server');
  });
});

describe('parsePathList', () => {
  it('trims and drops empty entries', () => {
    expect(parsePathList(' ~/Documents, , ~/Projects ,')).toEqual(['~/Documents', '~/Projects']);
    expect(parsePathList('   ')).toEqual([]);
  });
});
