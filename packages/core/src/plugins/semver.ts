/**
 * The part of semantic versioning plugins need: versions, comparison and npm's ranges (`^1.2`,
 * `~2.1.0`, `>=1.4 <2`, `1.x`, `1.2 - 1.4`, `||`), without a dependency. Pre-release versions
 * satisfy a range only when a comparator of it names a pre-release of the same version, as in npm
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
}

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `text` as a version, undefined when it is not one */
export function parseVersion(text: string): SemVer | undefined {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

/** Negative when `a` is lower, positive when higher, 0 when equal (build metadata aside) */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  operator: Operator;
  version: SemVer;
  /** A bound the range implies (`<2.0.0-0` of `^1.2`), not one it writes */
  implied?: boolean;
}

/** A partial version as a range writes it: `1`, `1.2`, `1.x`, `1.2.*` */
interface Partial {
  major?: number;
  minor?: number;
  patch?: number;
  prerelease: readonly (string | number)[];
}

const PARTIAL =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parsePartial(text: string): Partial | undefined {
  const match = PARTIAL.exec(text);
  if (!match) return undefined;
  const part = (value: string | undefined): number | undefined =>
    value === undefined || /^[xX*]$/.test(value) ? undefined : Number(value);
  const major = part(match[1]);
  const minor = major === undefined ? undefined : part(match[2]);
  const patch = minor === undefined ? undefined : part(match[3]);
  return {
    ...(major !== undefined && { major }),
    ...(minor !== undefined && { minor }),
    ...(patch !== undefined && { patch }),
    prerelease:
      patch !== undefined && match[4]
        ? match[4].split('.').map((piece) => (/^\d+$/.test(piece) ? Number(piece) : piece))
        : [],
  };
}

function version(
  major: number,
  minor: number,
  patch: number,
  prerelease: Partial['prerelease'] = []
): SemVer {
  return { major, minor, patch, prerelease };
}

/** The first version of the next major or minor: an implied upper bound */
function nextOf(major: number, minor?: number): Comparator {
  return {
    operator: '<',
    version:
      minor === undefined ? version(major + 1, 0, 0, [0]) : version(major, minor + 1, 0, [0]),
    implied: true,
  };
}

/** The comparators one space-separated part of a range stands for */
function comparatorsOf(token: string): Comparator[] | undefined {
  const operatorMatch = /^(\^|~>?|<=|>=|<|>|=)?\s*(.*)$/.exec(token);
  if (!operatorMatch) return undefined;
  const operator = operatorMatch[1] ?? '';
  const partial = parsePartial(operatorMatch[2] ?? '');
  if (!partial) return undefined;
  const { major, minor, patch, prerelease } = partial;
  if (major === undefined) {
    return operator === '<' || operator === '>'
      ? [{ operator: '<', version: version(0, 0, 0, [0]), implied: true }]
      : [];
  }
  const low: Comparator = {
    operator: '>=',
    version: version(major, minor ?? 0, patch ?? 0, prerelease),
  };
  switch (operator) {
    case '^': {
      const upper =
        major > 0 || minor === undefined
          ? nextOf(major)
          : minor > 0 || patch === undefined
            ? nextOf(0, minor)
            : { operator: '<' as const, version: version(0, 0, patch + 1, [0]), implied: true };
      return [low, upper];
    }
    case '~':
    case '~>':
      return [low, minor === undefined ? nextOf(major) : nextOf(major, minor)];
    case '':
    case '=':
      if (patch !== undefined) return [{ ...low, operator: '=' }];
      return [low, minor === undefined ? nextOf(major) : nextOf(major, minor)];
    case '>': {
      if (patch !== undefined) return [{ ...low, operator: '>' }];
      const above = minor === undefined ? nextOf(major) : nextOf(major, minor);
      return [{ operator: '>=', version: above.version, implied: true }];
    }
    case '>=':
      return [low];
    case '<':
      return patch === undefined
        ? [{ operator: '<', version: version(major, minor ?? 0, 0, [0]), implied: true }]
        : [{ ...low, operator: '<' }];
    case '<=':
      if (patch !== undefined) return [{ ...low, operator: '<=' }];
      return [minor === undefined ? nextOf(major) : nextOf(major, minor)];
    default:
      return undefined;
  }
}

/** A range as sets of comparators, any set satisfied satisfying the range */
function parseRange(range: string): Comparator[][] | undefined {
  const sets: Comparator[][] = [];
  for (const alternative of range.split('||')) {
    const text = alternative.trim().replace(/(\^|~>?|<=|>=|<|>|=)\s+/g, '$1');
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const from = parsePartial(hyphen[1] ?? '');
      const to = parsePartial(hyphen[2] ?? '');
      if (!from || !to) return undefined;
      const set: Comparator[] = [];
      if (from.major !== undefined) {
        set.push({
          operator: '>=',
          version: version(from.major, from.minor ?? 0, from.patch ?? 0, from.prerelease),
        });
      }
      if (to.major !== undefined) {
        set.push(
          to.patch !== undefined
            ? { operator: '<=', version: version(to.major, to.minor ?? 0, to.patch, to.prerelease) }
            : to.minor === undefined
              ? nextOf(to.major)
              : nextOf(to.major, to.minor)
        );
      }
      sets.push(set);
      continue;
    }
    const set: Comparator[] = [];
    for (const token of text === '' ? [] : text.split(/\s+/)) {
      const comparators = comparatorsOf(token);
      if (!comparators) return undefined;
      set.push(...comparators);
    }
    sets.push(set);
  }
  return sets;
}

/** Whether `range` is a range this module reads */
export function isValidRange(range: string): boolean {
  return parseRange(range) !== undefined;
}

function test(comparator: Comparator, candidate: SemVer): boolean {
  const order = compareVersions(candidate, comparator.version);
  switch (comparator.operator) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '=':
      return order === 0;
  }
}

/**
 * Whether `text` satisfies `range`. A pre-release satisfies it only when a comparator the range
 * writes names a pre-release of the same major, minor and patch (`^2.0.0-0` opts in to 2.0.0
 * pre-releases), as in npm
 */
export function satisfies(text: string, range: string): boolean {
  const candidate = parseVersion(text);
  const sets = parseRange(range);
  if (!candidate || !sets) return false;
  return sets.some((set) => {
    if (!set.every((comparator) => test(comparator, candidate))) return false;
    if (candidate.prerelease.length === 0) return true;
    return set.some(
      (comparator) =>
        comparator.implied !== true &&
        comparator.version.prerelease.length > 0 &&
        comparator.version.major === candidate.major &&
        comparator.version.minor === candidate.minor &&
        comparator.version.patch === candidate.patch
    );
  });
}

/** The highest of `versions` that satisfies `range`, undefined when none does */
export function maxSatisfying(versions: readonly string[], range: string): string | undefined {
  let best: { text: string; version: SemVer } | undefined;
  for (const text of versions) {
    if (!satisfies(text, range)) continue;
    const parsed = parseVersion(text);
    if (parsed && (!best || compareVersions(parsed, best.version) > 0))
      best = { text, version: parsed };
  }
  return best?.text;
}
