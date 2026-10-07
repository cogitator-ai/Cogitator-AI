import { describe, it, expect } from 'vitest';
import { assertCompatible, compatibilityIssues, IncompatibleSpecError } from '../kit/compat.js';
import { parseSpec, type ProjectSpecInput } from '../kit/spec.js';

function issues(overrides: Partial<ProjectSpecInput>): string[] {
  return compatibilityIssues(
    parseSpec({
      name: 'demo',
      app: 'script',
      memory: 'none',
      provider: 'openai',
      model: 'gpt-6.1-sol',
      packageManager: 'pnpm',
      ...overrides,
    })
  ).map((issue) => issue.message);
}

describe('compatibilityIssues', () => {
  it('accepts a consistent spec', () => {
    expect(issues({})).toEqual([]);
    expect(issues({ app: 'server', server: 'hono', features: ['a2a', 'rag'] })).toEqual([]);
  });

  it('needs a server framework for a server and nothing else for other apps', () => {
    expect(issues({ app: 'server' })).toContain('A server app needs a server framework');
    expect(issues({ server: 'hono' })).toContain('--server hono only applies to the server app');
  });

  it('needs channels for a bot and none elsewhere', () => {
    expect(issues({ app: 'channels', channels: [] })).toContain(
      'A messaging bot needs at least one channel'
    );
    expect(issues({ channels: ['telegram'] })).toContain(
      '--channels only applies to the messaging bot app'
    );
  });

  it('runs Tetsu on Bun without better-sqlite3', () => {
    expect(issues({ app: 'server', server: 'tetsu', packageManager: 'pnpm' })).toContain(
      'Tetsu servers run on Bun'
    );
    expect(
      issues({ app: 'server', server: 'tetsu', packageManager: 'bun', memory: 'sqlite' })
    ).toHaveLength(1);
  });

  it('needs embeddings for RAG and a realtime API for voice', () => {
    expect(
      issues({ provider: 'anthropic', model: 'claude-sonnet-5-5', features: ['rag'] })[0]
    ).toContain('RAG needs embeddings');
    expect(
      issues({ provider: 'anthropic', model: 'claude-sonnet-5-5', features: ['voice'] })[0]
    ).toContain('Realtime voice needs a realtime API');
    expect(issues({ app: 'next', features: ['voice'] })).toContain(
      'The voice feature runs its own WebSocket server'
    );
  });

  it('keeps add-ons with what they build on', () => {
    expect(issues({ features: ['durable'] })).toContain(
      'Durable workflows build on the workflows feature'
    );
    expect(issues({ vectorStore: 'qdrant' })).toContain(
      '--vector-store qdrant only applies to RAG'
    );
    expect(issues({ features: ['a2a'] })[0]).toContain('A2A serves agents over HTTP');
    expect(
      issues({ app: 'server', server: 'tetsu', packageManager: 'bun', features: ['a2a'] })[0]
    ).toContain('A2A serves agents over HTTP');
    expect(issues({ deploy: 'fly', memory: 'mongodb' })[0]).toContain(
      'Fly.io has no managed MongoDB'
    );
  });
});

describe('assertCompatible', () => {
  it('throws every issue at once with its fix', () => {
    try {
      assertCompatible(
        parseSpec({
          name: 'demo',
          app: 'server',
          features: ['durable'],
          memory: 'none',
          provider: 'openai',
          model: 'x',
          packageManager: 'pnpm',
        })
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IncompatibleSpecError);
      const { issues: found, message } = error as IncompatibleSpecError;
      expect(found).toHaveLength(2);
      expect(message).toContain('pass --server hono, express, fastify, koa or tetsu');
    }
  });
});
