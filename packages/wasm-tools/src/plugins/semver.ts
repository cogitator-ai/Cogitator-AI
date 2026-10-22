interface SemverInput {
  operation?: 'parse' | 'compare' | 'satisfies' | 'bump';
  version?: string;
  version2?: string;
  range?: string;
  release?: 'major' | 'minor' | 'patch' | 'prerelease';
  identifier?: string;
}

interface SemverOutput {
  error?: string;

  major?: number;
  minor?: number;
  patch?: number;
  prerelease?: (string | number)[];
  build?: string[];

  comparison?: -1 | 0 | 1;

  satisfies?: boolean;

  version?: string;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  build: string[];
  raw: string;
  version: string;
}

interface Comparator {
  op: string;
  ver: ParsedSemver | null;
}

const SEMVER_REGEX =
  /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const PARTIAL_REGEX =
  /^(?:v)?(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function isWild(val?: string): boolean {
  return val === undefined || val === '*' || val === 'x' || val === 'X';
}

function parseSemver(str: unknown): ParsedSemver {
  if (typeof str !== 'string') {
    throw new Error('Version must be a string');
  }
  const trimmed = str.trim().replace(/^=/, '');
  const match = SEMVER_REGEX.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid Semantic Version: ${str}`);
  }
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  const patch = parseInt(match[3], 10);

  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    throw new Error(
      `Invalid Semantic Version: ${str} (major, minor and patch must not exceed Number.MAX_SAFE_INTEGER)`
    );
  }

  const prereleaseStr = match[4];
  const buildStr = match[5];

  const prerelease: (string | number)[] = prereleaseStr
    ? prereleaseStr.split('.').map((id) => (/^\d+$/.test(id) ? parseInt(id, 10) : id))
    : [];

  const build: string[] = buildStr ? buildStr.split('.') : [];

  const version = `${major}.${minor}.${patch}${
    prerelease.length > 0 ? `-${prerelease.join('.')}` : ''
  }${build.length > 0 ? `+${build.join('.')}` : ''}`;

  return {
    major,
    minor,
    patch,
    prerelease,
    build,
    raw: trimmed,
    version,
  };
}

function compareSemver(v1: ParsedSemver, v2: ParsedSemver): -1 | 0 | 1 {
  if (v1.major !== v2.major) {
    return v1.major > v2.major ? 1 : -1;
  }
  if (v1.minor !== v2.minor) {
    return v1.minor > v2.minor ? 1 : -1;
  }
  if (v1.patch !== v2.patch) {
    return v1.patch > v2.patch ? 1 : -1;
  }

  const p1 = v1.prerelease;
  const p2 = v2.prerelease;

  if (p1.length === 0 && p2.length === 0) {
    return 0;
  }
  if (p1.length > 0 && p2.length === 0) {
    return -1;
  }
  if (p1.length === 0 && p2.length > 0) {
    return 1;
  }

  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    if (i >= p1.length) {
      return -1;
    }
    if (i >= p2.length) {
      return 1;
    }

    const id1 = p1[i];
    const id2 = p2[i];
    if (id1 === id2) {
      continue;
    }

    const isNum1 = typeof id1 === 'number';
    const isNum2 = typeof id2 === 'number';

    if (isNum1 && isNum2) {
      return (id1 as number) > (id2 as number) ? 1 : -1;
    }
    if (isNum1 && !isNum2) {
      return -1;
    }
    if (!isNum1 && isNum2) {
      return 1;
    }

    return (id1 as string) > (id2 as string) ? 1 : -1;
  }

  return 0;
}

function parseComparator(token: string): Comparator[] {
  let op = '';
  let rest = token;
  const opMatch = /^([<>=~^]+)(.*)$/.exec(token);
  if (opMatch) {
    op = opMatch[1];
    rest = opMatch[2].trim();
  }

  if (op === '' && (rest === '*' || rest === 'x' || rest === 'X' || rest === '')) {
    return [{ op: '*', ver: null }];
  }

  if (op === '^') {
    if (!rest) {
      throw new Error('Invalid range: ^ must be followed by a version');
    }
    const m = PARTIAL_REGEX.exec(rest);
    if (!m) {
      throw new Error(`Invalid version in range: ${rest}`);
    }
    const [, M, m_, p_, pre] = m;
    if (isWild(M)) {
      return [{ op: '*', ver: null }];
    }
    const major = parseInt(M, 10);
    if (isWild(m_)) {
      if (major === 0) {
        return [{ op: '<', ver: parseSemver('1.0.0-0') }];
      }
      return [
        { op: '>=', ver: parseSemver(`${major}.0.0`) },
        { op: '<', ver: parseSemver(`${major + 1}.0.0-0`) },
      ];
    }
    const minor = parseInt(m_, 10);
    if (isWild(p_)) {
      if (major === 0) {
        if (minor === 0) {
          return [{ op: '<', ver: parseSemver('0.1.0-0') }];
        }
        return [
          { op: '>=', ver: parseSemver(`0.${minor}.0`) },
          { op: '<', ver: parseSemver(`0.${minor + 1}.0-0`) },
        ];
      }
      return [
        { op: '>=', ver: parseSemver(`${major}.${minor}.0`) },
        { op: '<', ver: parseSemver(`${major + 1}.0.0-0`) },
      ];
    }
    const patch = parseInt(p_, 10);
    const fullVerStr = `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`;
    const fullVer = parseSemver(fullVerStr);
    if (major > 0) {
      return [
        { op: '>=', ver: fullVer },
        { op: '<', ver: parseSemver(`${major + 1}.0.0-0`) },
      ];
    }
    if (minor > 0) {
      return [
        { op: '>=', ver: fullVer },
        { op: '<', ver: parseSemver(`0.${minor + 1}.0-0`) },
      ];
    }
    return [
      { op: '>=', ver: fullVer },
      { op: '<', ver: parseSemver(`0.0.${patch + 1}-0`) },
    ];
  }

  if (op === '~') {
    if (!rest) {
      throw new Error('Invalid range: ~ must be followed by a version');
    }
    const m = PARTIAL_REGEX.exec(rest);
    if (!m) {
      throw new Error(`Invalid version in range: ${rest}`);
    }
    const [, M, m_, p_, pre] = m;
    if (isWild(M)) {
      return [{ op: '*', ver: null }];
    }
    const major = parseInt(M, 10);
    if (isWild(m_)) {
      if (major === 0) {
        return [{ op: '<', ver: parseSemver('1.0.0-0') }];
      }
      return [
        { op: '>=', ver: parseSemver(`${major}.0.0`) },
        { op: '<', ver: parseSemver(`${major + 1}.0.0-0`) },
      ];
    }
    const minor = parseInt(m_, 10);
    if (isWild(p_)) {
      return [
        { op: '>=', ver: parseSemver(`${major}.${minor}.0`) },
        { op: '<', ver: parseSemver(`${major}.${minor + 1}.0-0`) },
      ];
    }
    const patch = parseInt(p_, 10);
    const fullVerStr = `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`;
    const fullVer = parseSemver(fullVerStr);
    return [
      { op: '>=', ver: fullVer },
      { op: '<', ver: parseSemver(`${major}.${minor + 1}.0-0`) },
    ];
  }

  if (op === '>' || op === '>=' || op === '<' || op === '<=') {
    if (!rest) {
      throw new Error('Invalid range: operator must be followed by a version');
    }
    const m = PARTIAL_REGEX.exec(rest);
    if (!m) {
      throw new Error(`Invalid version in range: ${rest}`);
    }
    const [, M, m_, p_, pre] = m;
    if (isWild(M)) {
      if (op === '<' || op === '>') {
        return [{ op: '<', ver: parseSemver('0.0.0-0') }];
      }
      return [{ op: '*', ver: null }];
    }
    const major = parseInt(M, 10);
    if (isWild(m_)) {
      if (op === '>') return [{ op: '>=', ver: parseSemver(`${major + 1}.0.0`) }];
      if (op === '>=') return [{ op: '>=', ver: parseSemver(`${major}.0.0`) }];
      if (op === '<') return [{ op: '<', ver: parseSemver(`${major}.0.0-0`) }];
      if (op === '<=') return [{ op: '<', ver: parseSemver(`${major + 1}.0.0-0`) }];
    }
    const minor = parseInt(m_, 10);
    if (isWild(p_)) {
      if (op === '>') return [{ op: '>=', ver: parseSemver(`${major}.${minor + 1}.0`) }];
      if (op === '>=') return [{ op: '>=', ver: parseSemver(`${major}.${minor}.0`) }];
      if (op === '<') return [{ op: '<', ver: parseSemver(`${major}.${minor}.0-0`) }];
      if (op === '<=') return [{ op: '<', ver: parseSemver(`${major}.${minor + 1}.0-0`) }];
    }
    const patch = parseInt(p_, 10);
    const fullVer = parseSemver(`${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`);
    return [{ op, ver: fullVer }];
  }

  if (op === '=' || op === '') {
    const m = PARTIAL_REGEX.exec(rest);
    if (!m) {
      throw new Error(`Invalid version in range: ${rest}`);
    }
    const [, M, m_, p_, pre] = m;
    if (isWild(M)) {
      return [{ op: '*', ver: null }];
    }
    const major = parseInt(M, 10);
    if (isWild(m_)) {
      return [
        { op: '>=', ver: parseSemver(`${major}.0.0`) },
        { op: '<', ver: parseSemver(`${major + 1}.0.0-0`) },
      ];
    }
    const minor = parseInt(m_, 10);
    if (isWild(p_)) {
      return [
        { op: '>=', ver: parseSemver(`${major}.${minor}.0`) },
        { op: '<', ver: parseSemver(`${major}.${minor + 1}.0-0`) },
      ];
    }
    const patch = parseInt(p_, 10);
    const fullVer = parseSemver(`${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`);
    return [{ op: '=', ver: fullVer }];
  }

  throw new Error(`Unsupported operator in range: ${op}`);
}

function parseRange(rangeStr: unknown): Comparator[][] {
  if (typeof rangeStr !== 'string') {
    throw new Error('Range must be a string');
  }
  const trimmed = rangeStr.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') {
    return [[{ op: '*', ver: null }]];
  }

  const setStrings = trimmed.split('||');
  if (setStrings.some((s) => s.trim() === '')) {
    throw new Error('Invalid SemVer range: empty branch around ||');
  }

  return setStrings.map((setStr) => {
    let s = setStr.trim();

    const hyphenMatch = /^\s*([0-9a-zA-Z.*+-]+)\s+-\s+([0-9a-zA-Z.*+-]+)\s*$/.exec(s);
    if (hyphenMatch) {
      const left = hyphenMatch[1];
      const right = hyphenMatch[2];
      const lm = PARTIAL_REGEX.exec(left);
      const rm = PARTIAL_REGEX.exec(right);
      if (!lm || !rm) {
        throw new Error(`Invalid hyphen range: ${s}`);
      }
      const lMajor = parseInt(lm[1], 10);
      const lMinor = isWild(lm[2]) ? 0 : parseInt(lm[2], 10);
      const lPatch = isWild(lm[3]) ? 0 : parseInt(lm[3], 10);
      const leftVer = parseSemver(`${lMajor}.${lMinor}.${lPatch}${lm[4] ? `-${lm[4]}` : ''}`);
      const comps: Comparator[] = [{ op: '>=', ver: leftVer }];

      if (isWild(rm[2])) {
        comps.push({
          op: '<',
          ver: parseSemver(`${parseInt(rm[1], 10) + 1}.0.0-0`),
        });
      } else if (isWild(rm[3])) {
        comps.push({
          op: '<',
          ver: parseSemver(`${rm[1]}.${parseInt(rm[2], 10) + 1}.0-0`),
        });
      } else {
        comps.push({ op: '<=', ver: parseSemver(right) });
      }
      return comps;
    }

    s = s.replace(/([<>=~^]+)\s+/g, '$1');
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      throw new Error('Invalid range: empty comparator set');
    }
    const comps: Comparator[] = [];
    for (const token of tokens) {
      comps.push(...parseComparator(token));
    }
    return comps;
  });
}

function satisfiesRange(versionStr: unknown, rangeStr: unknown): boolean {
  const v = parseSemver(versionStr);
  const rangeSets = parseRange(rangeStr);

  return rangeSets.some((compSet) => {
    if (v.prerelease.length > 0) {
      const hasMatchingPrereleaseComp = compSet.some(
        (c) =>
          c.ver &&
          c.ver.prerelease.length > 0 &&
          c.ver.major === v.major &&
          c.ver.minor === v.minor &&
          c.ver.patch === v.patch
      );
      if (!hasMatchingPrereleaseComp) {
        return false;
      }
    }

    return compSet.every((c) => {
      if (c.op === '*') return true;
      if (!c.ver) return true;
      const cmp = compareSemver(v, c.ver);
      if (c.op === '=') return cmp === 0;
      if (c.op === '>') return cmp > 0;
      if (c.op === '>=') return cmp >= 0;
      if (c.op === '<') return cmp < 0;
      if (c.op === '<=') return cmp <= 0;
      return false;
    });
  });
}

function bumpVersion(versionStr: unknown, releaseType: unknown, identifier?: string): string {
  const v = parseSemver(versionStr);
  const rel = typeof releaseType === 'string' ? releaseType.toLowerCase() : '';

  let major = v.major;
  let minor = v.minor;
  let patch = v.patch;
  let prerelease: (string | number)[] = [];

  switch (rel) {
    case 'major':
      if (v.prerelease.length > 0 && v.minor === 0 && v.patch === 0) {
        major = v.major;
      } else {
        major = v.major + 1;
      }
      minor = 0;
      patch = 0;
      break;

    case 'minor':
      if (v.prerelease.length > 0 && v.patch === 0) {
        minor = v.minor;
      } else {
        minor = v.minor + 1;
      }
      patch = 0;
      break;

    case 'patch':
      if (v.prerelease.length > 0) {
        patch = v.patch;
      } else {
        patch = v.patch + 1;
      }
      break;

    case 'prerelease': {
      const id = identifier && identifier.trim() !== '' ? identifier.trim() : undefined;
      if (v.prerelease.length === 0) {
        patch = v.patch + 1;
        prerelease = id ? [id, 0] : [0];
      } else {
        if (id) {
          if (v.prerelease[0] === id) {
            const next = [...v.prerelease];
            let bumped = false;
            for (let i = next.length - 1; i >= 0; i--) {
              if (typeof next[i] === 'number') {
                next[i] = (next[i] as number) + 1;
                bumped = true;
                break;
              }
            }
            if (!bumped) {
              next.push(0);
            }
            prerelease = next;
          } else {
            prerelease = [id, 0];
          }
        } else {
          const next = [...v.prerelease];
          let bumped = false;
          for (let i = next.length - 1; i >= 0; i--) {
            if (typeof next[i] === 'number') {
              next[i] = (next[i] as number) + 1;
              bumped = true;
              break;
            }
          }
          if (!bumped) {
            next.push(0);
          }
          prerelease = next;
        }
      }
      break;
    }

    default:
      throw new Error(
        `Invalid release type: "${String(releaseType)}". Expected "major", "minor", "patch", or "prerelease"`
      );
  }

  return `${major}.${minor}.${patch}${prerelease.length > 0 ? `-${prerelease.join('.')}` : ''}`;
}

export function semver(): number {
  try {
    const inputStr = Host.inputString();
    let input: SemverInput;
    try {
      input = JSON.parse(inputStr);
    } catch {
      throw new Error('Invalid JSON input');
    }

    if (!input || typeof input !== 'object') {
      throw new Error('Input must be a JSON object');
    }

    const operation = input.operation;
    if (!operation) {
      throw new Error('operation is required (must be one of: parse, compare, satisfies, bump)');
    }

    const version = input.version;

    switch (operation) {
      case 'parse': {
        if (version === undefined || version === null) {
          throw new Error('version is required for parse operation');
        }
        const parsed = parseSemver(version);
        const output: SemverOutput = {
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          prerelease: parsed.prerelease,
          build: parsed.build,
          version: parsed.version,
        };
        Host.outputString(JSON.stringify(output));
        return 0;
      }

      case 'compare': {
        const v2Str = input.version2;
        if (version === undefined || v2Str === undefined) {
          throw new Error('compare operation requires version and version2');
        }
        const v1 = parseSemver(version);
        const v2 = parseSemver(v2Str);
        const cmp = compareSemver(v1, v2);
        const output: SemverOutput = {
          comparison: cmp,
        };
        Host.outputString(JSON.stringify(output));
        return 0;
      }

      case 'satisfies': {
        if (version === undefined || input.range === undefined) {
          throw new Error('satisfies operation requires version and range');
        }
        const res = satisfiesRange(version, input.range);
        const output: SemverOutput = {
          satisfies: res,
        };
        Host.outputString(JSON.stringify(output));
        return 0;
      }

      case 'bump': {
        const release = input.release;
        if (version === undefined || release === undefined) {
          throw new Error('bump operation requires version and release type');
        }
        const id = input.identifier;
        const bumped = bumpVersion(version, release, id);
        const output: SemverOutput = {
          version: bumped,
        };
        Host.outputString(JSON.stringify(output));
        return 0;
      }

      default:
        throw new Error(
          `Unknown operation: "${String(
            operation
          )}". Expected "parse", "compare", "satisfies", or "bump"`
        );
    }
  } catch (error) {
    const output: SemverOutput = {
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
