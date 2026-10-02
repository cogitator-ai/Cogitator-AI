/**
 * Utilities for parsing resource limits
 */

/**
 * Parse memory string to bytes. Accepts `B`, `KB`/`K`/`KiB`, `MB`/`M`/`MiB`, `GB`/`G`/`GiB`
 * and `TB`/`T`/`TiB` (binary multiples, case-insensitive, Docker-style short suffixes included).
 * @example parseMemory('256MB') => 268435456
 */
export function parseMemory(memory: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|K|KB|KIB|M|MB|MIB|G|GB|GIB|T|TB|TIB)?$/i.exec(memory.trim());
  if (!match) {
    throw new Error(`Invalid memory format: ${memory}`);
  }

  const value = parseFloat(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase().replace(/I?B$/, '') || 'B';

  const multipliers: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024,
    T: 1024 * 1024 * 1024 * 1024,
  };

  return Math.floor(value * multipliers[unit]);
}

/**
 * Parse CPU count to nanoseconds (Docker format)
 * @example parseCpus(0.5) => 500000000
 */
export function cpusToNanoCpus(cpus: number): number {
  return Math.floor(cpus * 1e9);
}
