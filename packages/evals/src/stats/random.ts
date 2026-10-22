/**
 * `Math.random`, or a mulberry32 generator seeded by the FNV-1a hash of `seed`, so every number
 * and string seeds its own sequence (`1.2` and `1.7`, `-1` and `2 ** 32 - 1` alike)
 */
export function seededRandom(seed: number | string | undefined): () => number {
  if (seed === undefined) return Math.random;
  let state = hashSeed(String(seed));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
