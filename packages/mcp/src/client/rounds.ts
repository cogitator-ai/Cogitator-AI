/**
 * The rounds a client's paused calls wait on (multi round-trip requests of protocol 2026-07-28)
 */

import type { MCPClientRoundRecord, MCPClientRoundStore } from '../types';

export const DEFAULT_ROUND_TTL_MS = 60 * 60 * 1000;

/** Rounds kept in the client's memory until they expire, the default {@link MCPClientRoundStore} */
export class InMemoryMCPClientRoundStore implements MCPClientRoundStore {
  private readonly records = new Map<string, MCPClientRoundRecord>();

  get(key: string): Promise<MCPClientRoundRecord | undefined> {
    this.sweep();
    const record = this.records.get(key);
    return Promise.resolve(record && copy(record));
  }

  set(key: string, record: MCPClientRoundRecord): Promise<void> {
    this.sweep();
    this.records.set(key, copy(record));
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }
}

function copy(record: MCPClientRoundRecord): MCPClientRoundRecord {
  return { ...record, round: [...record.round], asked: [...record.asked] };
}
