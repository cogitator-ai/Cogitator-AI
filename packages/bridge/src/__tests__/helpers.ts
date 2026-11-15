import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_CAPABILITIES, type AgentRecord, type Letter } from '../types';

/** A folder that lives for one test, removed by the returned function. */
export function tempDir(prefix = 'cogitator-bridge-'): { dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export const T0 = Date.parse('2026-11-15T10:00:00.000Z');

export function at(offsetMs = 0): string {
  return new Date(T0 + offsetMs).toISOString();
}

export function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: 'claude@demo',
    harness: 'claude-code',
    sessionId: 'session-claude',
    project: '/work/demo',
    cwd: '/work/demo',
    delivery: 'inbox',
    capabilities: NO_CAPABILITIES,
    status: 'active',
    registeredAt: at(),
    lastSeenAt: at(),
    ...overrides,
  };
}

export function letterInput(overrides: Partial<Omit<Letter, 'seq'>> = {}): Omit<Letter, 'seq'> {
  return {
    id: 'ltr_1',
    job: 1,
    kind: 'task',
    from: 'claude@demo',
    to: 'codex@demo',
    body: 'Write the tests',
    state: 'queued',
    createdAt: at(),
    attempts: 0,
    ...overrides,
  };
}
