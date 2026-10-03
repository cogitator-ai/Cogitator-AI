import { describe, it, expect } from 'vitest';
import {
  channelsKeptOnEdit,
  extractMcpName,
  parsePathList,
  resolveMemoryConfig,
  splitCommandLine,
} from '../commands/wizard.js';

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

describe('resolveMemoryConfig', () => {
  it('keeps an existing postgres memory config on edit', () => {
    const existing = {
      adapter: 'postgres' as const,
      connectionString: 'postgres://localhost/cogitator',
      autoExtract: false,
      knowledgeGraph: true,
    };
    expect(resolveMemoryConfig(existing, undefined)).toEqual({
      ...existing,
      compaction: { threshold: 50 },
    });
  });

  it('uses sqlite with the chosen path and keeps other memory settings', () => {
    expect(
      resolveMemoryConfig(
        {
          adapter: 'sqlite',
          path: '~/old.db',
          autoExtract: false,
          knowledgeGraph: true,
          compaction: { threshold: 80 },
        },
        '~/new.db'
      )
    ).toEqual({
      adapter: 'sqlite',
      path: '~/new.db',
      autoExtract: false,
      knowledgeGraph: true,
      compaction: { threshold: 80 },
    });
  });

  it('applies defaults for a fresh config', () => {
    expect(resolveMemoryConfig(undefined, '~/.cogitator/memory.db')).toEqual({
      adapter: 'sqlite',
      path: '~/.cogitator/memory.db',
      autoExtract: true,
      knowledgeGraph: true,
      compaction: { threshold: 50 },
    });
  });
});

describe('channelsKeptOnEdit', () => {
  it('keeps channels the wizard does not set up and drops the ones it asks about', () => {
    expect(
      channelsKeptOnEdit({
        telegram: { ownerIds: ['1'] },
        whatsapp: { ownerIds: ['15550001111'], sessionPath: '~/wa' },
        webchat: { port: 9000 },
      })
    ).toEqual({
      whatsapp: { ownerIds: ['15550001111'], sessionPath: '~/wa' },
      webchat: { port: 9000 },
    });
    expect(channelsKeptOnEdit(undefined)).toEqual({});
  });
});
