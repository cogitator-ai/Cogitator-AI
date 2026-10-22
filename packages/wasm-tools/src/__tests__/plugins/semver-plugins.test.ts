import { describe, it, expect } from 'vitest';
import { runPlugin, pluginCall } from '../helpers/run-plugin';

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

const semver = pluginCall<SemverOutput>('semver', 'semver');

function satisfies(version: string, range: string): boolean {
  const out = semver({ operation: 'satisfies', version, range });
  if (out.error) {
    throw new Error(out.error);
  }
  return !!out.satisfies;
}

describe('semver plugin: parse', () => {
  it('parses standard version', () => {
    const res = runPlugin<SemverOutput>('semver', 'semver', {
      operation: 'parse',
      version: '1.2.3',
    });
    expect(res.code).toBe(0);
    expect(res.output.major).toBe(1);
    expect(res.output.minor).toBe(2);
    expect(res.output.patch).toBe(3);
    expect(res.output.prerelease).toEqual([]);
    expect(res.output.build).toEqual([]);
    expect(res.output.version).toBe('1.2.3');
  });

  it('parses version with prerelease identifiers', () => {
    const res = semver({ operation: 'parse', version: '1.0.0-alpha.1' });
    expect(res.major).toBe(1);
    expect(res.minor).toBe(0);
    expect(res.patch).toBe(0);
    expect(res.prerelease).toEqual(['alpha', 1]);
    expect(res.build).toEqual([]);
  });

  it('parses version with build metadata', () => {
    const res = semver({ operation: 'parse', version: '1.0.0+20130313144700' });
    expect(res.major).toBe(1);
    expect(res.minor).toBe(0);
    expect(res.patch).toBe(0);
    expect(res.prerelease).toEqual([]);
    expect(res.build).toEqual(['20130313144700']);
    expect(Object.keys(res).sort()).toEqual(
      ['build', 'major', 'minor', 'patch', 'prerelease', 'version'].sort()
    );
  });

  it('parses version with both prerelease and build metadata', () => {
    const res = semver({
      operation: 'parse',
      version: '1.0.0-beta.2+exp.sha.5114f85',
    });
    expect(res.major).toBe(1);
    expect(res.minor).toBe(0);
    expect(res.patch).toBe(0);
    expect(res.prerelease).toEqual(['beta', 2]);
    expect(res.build).toEqual(['exp', 'sha', '5114f85']);
  });

  it('accepts optional leading v prefix', () => {
    const res = semver({ operation: 'parse', version: 'v2.4.6' });
    expect(res.major).toBe(2);
    expect(res.minor).toBe(4);
    expect(res.patch).toBe(6);
  });

  it.each([
    '',
    'not-a-version',
    '1.2',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+build..1',
    '1.2.3-alpha@',
    '1.2.3+build@',
    '1.2.3-',
    '1.2.3+',
  ])('returns error for malformed version: %s', (version) => {
    const res = runPlugin<SemverOutput>('semver', 'semver', {
      operation: 'parse',
      version,
    });
    expect(res.code).toBe(1);
    expect(res.output.error).toBeDefined();
    expect(res.output.error).toContain('Invalid Semantic Version');
  });

  it.each(['9007199254740991.0.0', '0.9007199254740991.0', '0.0.9007199254740991'])(
    'accepts components at Number.MAX_SAFE_INTEGER: %s',
    (version) => {
      const res = semver({ operation: 'parse', version });
      expect(res.error).toBeUndefined();
    }
  );

  it.each([
    '9007199254740992.0.0',
    '9007199254740993.0.0',
    '0.9007199254740992.0',
    '0.0.9007199254740992',
    '999999999999999999.0.0',
  ])('rejects unsafe component without precision loss: %s', (version) => {
    const res = runPlugin<SemverOutput>('semver', 'semver', {
      operation: 'parse',
      version,
    });
    expect(res.code).toBe(1);
    expect(res.output.error).toBeDefined();
    expect(res.output.error).toContain('Invalid Semantic Version');
  });

  it('returns error when version is missing for parse', () => {
    const res = runPlugin<SemverOutput>('semver', 'semver', {
      operation: 'parse',
    });
    expect(res.code).toBe(1);
    expect(res.output.error).toContain('version is required');
  });
});

describe('semver plugin: compare', () => {
  it('returns 0 for identical versions', () => {
    const res = semver({
      operation: 'compare',
      version: '1.2.3',
      version2: '1.2.3',
    });
    expect(res.comparison).toBe(0);
    expect(res.comparison).toBe(0);
  });

  it('correctly compares major, minor, patch precedence numerically', () => {
    expect(semver({ operation: 'compare', version: '1.0.0', version2: '2.0.0' }).comparison).toBe(
      -1
    );
    expect(semver({ operation: 'compare', version: '2.0.0', version2: '1.0.0' }).comparison).toBe(
      1
    );
    expect(semver({ operation: 'compare', version: '1.1.0', version2: '1.2.0' }).comparison).toBe(
      -1
    );
    expect(semver({ operation: 'compare', version: '1.2.0', version2: '1.1.0' }).comparison).toBe(
      1
    );
    expect(semver({ operation: 'compare', version: '1.1.1', version2: '1.1.2' }).comparison).toBe(
      -1
    );
    expect(semver({ operation: 'compare', version: '1.1.2', version2: '1.1.1' }).comparison).toBe(
      1
    );
  });

  it('prerelease has lower precedence than normal version', () => {
    expect(
      semver({ operation: 'compare', version: '1.0.0-alpha', version2: '1.0.0' }).comparison
    ).toBe(-1);
    expect(
      semver({ operation: 'compare', version: '1.0.0', version2: '1.0.0-alpha' }).comparison
    ).toBe(1);
  });

  it('implements SemVer section 11 precedence sequence', () => {
    const seq = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];

    for (let i = 0; i < seq.length - 1; i++) {
      const v1 = seq[i];
      const v2 = seq[i + 1];
      const res = semver({ operation: 'compare', version: v1, version2: v2 });
      expect(res.comparison).toBe(-1);
      const rev = semver({ operation: 'compare', version: v2, version2: v1 });
      expect(rev.comparison).toBe(1);
    }
  });

  it('ignores build metadata in precedence comparison', () => {
    expect(
      semver({ operation: 'compare', version: '1.0.0+build.1', version2: '1.0.0+build.2' })
        .comparison
    ).toBe(0);
    expect(
      semver({
        operation: 'compare',
        version: '1.0.0-alpha+001',
        version2: '1.0.0-alpha+002',
      }).comparison
    ).toBe(0);
    expect(
      semver({
        operation: 'compare',
        version: '1.0.0+20130313144700',
        version2: '1.0.0',
      }).comparison
    ).toBe(0);
  });

  it('requires version2 instead of the removed other alias', () => {
    const res = semver({
      operation: 'compare',
      version: '1.0.0',
      other: '2.0.0',
    });
    expect(res.error).toBeDefined();
  });

  it('returns error for malformed input in compare', () => {
    expect(semver({ operation: 'compare', version: '1.0.0' }).error).toBeDefined();
    expect(semver({ operation: 'compare', version: 'bad', version2: '1.0.0' }).error).toBeDefined();
    expect(semver({ operation: 'compare', version: '1.0.0', version2: 'bad' }).error).toBeDefined();
  });
});

describe('semver plugin: satisfies', () => {
  it('satisfies required assertions', () => {
    expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
  });

  it('handles caret (^) ranges across 0.x and 0.0.x boundaries', () => {
    expect(satisfies('1.2.3', '^1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '^1.2.3')).toBe(true);
    expect(satisfies('1.2.2', '^1.2.3')).toBe(false);
    expect(satisfies('2.0.0', '^1.2.3')).toBe(false);

    expect(satisfies('0.2.3', '^0.2.3')).toBe(true);
    expect(satisfies('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfies('0.2.2', '^0.2.3')).toBe(false);

    expect(satisfies('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfies('0.0.2', '^0.0.3')).toBe(false);
  });

  it('handles tilde (~) ranges and boundaries', () => {
    expect(satisfies('1.2.3', '~1.2.3')).toBe(true);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '~1.2.3')).toBe(false);

    expect(satisfies('1.2.0', '~1.2')).toBe(true);
    expect(satisfies('1.2.5', '~1.2')).toBe(true);
    expect(satisfies('1.3.0', '~1.2')).toBe(false);

    expect(satisfies('1.0.0', '~1')).toBe(true);
    expect(satisfies('1.9.9', '~1')).toBe(true);
    expect(satisfies('2.0.0', '~1')).toBe(false);
  });

  it('handles relational operators (>=, <=, >, <, =)', () => {
    expect(satisfies('1.0.0', '>=1.0.0')).toBe(true);
    expect(satisfies('0.9.9', '>=1.0.0')).toBe(false);

    expect(satisfies('1.0.0', '<=1.0.0')).toBe(true);
    expect(satisfies('1.0.1', '<=1.0.0')).toBe(false);

    expect(satisfies('1.0.1', '>1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '>1.0.0')).toBe(false);

    expect(satisfies('0.9.9', '<1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '<1.0.0')).toBe(false);

    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfies('1.2.4', '=1.2.3')).toBe(false);

    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('handles x / X / * wildcards', () => {
    expect(satisfies('1.2.3', '*')).toBe(true);
    expect(satisfies('1.2.3', 'x')).toBe(true);
    expect(satisfies('1.2.3', 'X')).toBe(true);

    expect(satisfies('1.5.0', '1.x')).toBe(true);
    expect(satisfies('1.0.0', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);

    expect(satisfies('1.2.5', '1.2.x')).toBe(true);
    expect(satisfies('1.3.0', '1.2.x')).toBe(false);

    expect(satisfies('1.5.0', '1.*')).toBe(true);
    expect(satisfies('2.0.0', '1.*')).toBe(false);
    expect(satisfies('1.2.5', '1.2.*')).toBe(true);
    expect(satisfies('1.3.0', '1.2.*')).toBe(false);

    expect(satisfies('1.5.0', '1.X')).toBe(true);
    expect(satisfies('1.2.5', '1.2.X')).toBe(true);
  });

  it('handles || union ranges', () => {
    expect(satisfies('1.2.3', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('2.5.0', '^1.0.0 || ^2.0.0')).toBe(true);
    expect(satisfies('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false);
  });

  it('handles prerelease isolation in ranges', () => {
    expect(satisfies('1.2.3-alpha.1', '^1.0.0')).toBe(false);
    expect(satisfies('1.2.3-alpha.1', '>=1.0.0')).toBe(false);
    expect(satisfies('1.2.3-alpha.1', '*')).toBe(false);

    expect(satisfies('1.2.3-alpha.1', '^1.2.3-alpha')).toBe(true);
    expect(satisfies('1.2.3-alpha.2', '^1.2.3-alpha.1')).toBe(true);
    expect(satisfies('1.2.3-beta.1', '^1.2.3-alpha.1')).toBe(true);

    expect(satisfies('1.2.4-alpha.1', '^1.2.3-alpha')).toBe(false);
  });

  it('handles hyphen ranges', () => {
    expect(satisfies('1.5.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('1.0.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '1.0.0 - 2.0.0')).toBe(true);
    expect(satisfies('2.0.1', '1.0.0 - 2.0.0')).toBe(false);
    expect(satisfies('0.9.9', '1.0.0 - 2.0.0')).toBe(false);
  });

  it('returns error for malformed versions and ranges in satisfies', () => {
    expect(semver({ operation: 'satisfies', version: 'bad', range: '^1.0.0' }).error).toBeDefined();
    expect(
      semver({ operation: 'satisfies', version: '1.2.3', range: 'invalid-range' }).error
    ).toBeDefined();
    expect(semver({ operation: 'satisfies', version: '1.2.3', range: '>' }).error).toBeDefined();
    expect(
      semver({ operation: 'satisfies', version: '1.2.3', range: '1.0.0 ||' }).error
    ).toBeDefined();
    expect(
      semver({ operation: 'satisfies', version: '1.2.3', range: '|| 1.0.0' }).error
    ).toBeDefined();
  });
});

describe('semver plugin: bump', () => {
  it('bumps major version', () => {
    expect(semver({ operation: 'bump', version: '1.2.3', release: 'major' }).version).toBe('2.0.0');
    expect(semver({ operation: 'bump', version: '1.0.0-alpha.1', release: 'major' }).version).toBe(
      '1.0.0'
    );
    expect(semver({ operation: 'bump', version: '1.2.0-alpha.1', release: 'major' }).version).toBe(
      '2.0.0'
    );
  });

  it('bumps minor version', () => {
    expect(semver({ operation: 'bump', version: '1.2.3', release: 'minor' }).version).toBe('1.3.0');
    expect(semver({ operation: 'bump', version: '1.2.0-beta.1', release: 'minor' }).version).toBe(
      '1.2.0'
    );
    expect(semver({ operation: 'bump', version: '1.2.3-beta.1', release: 'minor' }).version).toBe(
      '1.3.0'
    );
  });

  it('bumps patch version', () => {
    expect(semver({ operation: 'bump', version: '1.2.3', release: 'patch' }).version).toBe('1.2.4');
    expect(semver({ operation: 'bump', version: '1.2.3-rc.1', release: 'patch' }).version).toBe(
      '1.2.3'
    );
  });

  it('bumps prerelease without identifier', () => {
    expect(semver({ operation: 'bump', version: '1.2.3', release: 'prerelease' }).version).toBe(
      '1.2.4-0'
    );
    expect(semver({ operation: 'bump', version: '1.2.4-0', release: 'prerelease' }).version).toBe(
      '1.2.4-1'
    );
    expect(
      semver({ operation: 'bump', version: '1.2.4-alpha', release: 'prerelease' }).version
    ).toBe('1.2.4-alpha.0');
    expect(
      semver({ operation: 'bump', version: '1.2.4-alpha.0', release: 'prerelease' }).version
    ).toBe('1.2.4-alpha.1');
  });

  it('bumps prerelease with identifier', () => {
    expect(
      semver({
        operation: 'bump',
        version: '1.2.3',
        release: 'prerelease',
        identifier: 'beta',
      }).version
    ).toBe('1.2.4-beta.0');

    expect(
      semver({
        operation: 'bump',
        version: '1.2.4-beta.0',
        release: 'prerelease',
        identifier: 'beta',
      }).version
    ).toBe('1.2.4-beta.1');

    expect(
      semver({
        operation: 'bump',
        version: '1.2.4-beta.1',
        release: 'prerelease',
        identifier: 'rc',
      }).version
    ).toBe('1.2.4-rc.0');
  });

  it('strips build metadata on bump', () => {
    expect(
      semver({
        operation: 'bump',
        version: '1.2.3+build.1',
        release: 'patch',
      }).version
    ).toBe('1.2.4');
  });

  it('requires release and ignores other names for it', () => {
    expect(semver({ operation: 'bump', version: '1.2.3', type: 'minor' }).error).toBe(
      'bump operation requires version and release type'
    );
  });

  it('returns error for malformed input in bump', () => {
    expect(semver({ operation: 'bump', version: 'bad', release: 'patch' }).error).toBeDefined();
    expect(semver({ operation: 'bump', version: '1.2.3' }).error).toBeDefined();
    expect(semver({ operation: 'bump', version: '1.2.3', release: 'invalid' }).error).toBeDefined();
  });
});

describe('semver plugin: error handling and operation validation', () => {
  it('returns error for unknown operation', () => {
    const res = semver({ operation: 'unknown' as any, version: '1.0.0' });
    expect(res.error).toBeDefined();
    expect(res.error).toContain('Unknown operation');
  });

  it('returns error for missing operation', () => {
    const res = semver({ version: '1.0.0' });
    expect(res.error).toBeDefined();
    expect(res.error).toContain('operation is required');
  });
});
