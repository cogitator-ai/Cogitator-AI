import { customAlphabet } from 'nanoid';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface PendingPairing {
  code: string;
  userId: string;
  channelType: string;
  expiresAt: number;
}

export function generatePairingCode(length: number): string {
  return customAlphabet(PAIRING_ALPHABET, length)();
}

export function parsePairCommand(text: string): string | null {
  const match = /^\/pair(?:@\S+)?\s+(\S+)\s*$/i.exec(text.trim());
  return match ? match[1].toUpperCase() : null;
}

export function isPairCommand(text: string): boolean {
  return /^\/pair(?:@\S+)?(?:\s|$)/i.test(text.trim());
}

export function prunePending(pending: Map<string, PendingPairing>, now: number): void {
  for (const [code, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(code);
  }
}

export function findPendingByUser(
  pending: Map<string, PendingPairing>,
  userKey: string
): PendingPairing | undefined {
  for (const p of pending.values()) {
    if (`${p.channelType}:${p.userId}` === userKey) return p;
  }
  return undefined;
}
