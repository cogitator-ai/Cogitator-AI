import { describe, expect, it } from 'vitest';
import {
  FindingsSchema,
  atLeast,
  findingLine,
  findingsCount,
  holdsUp,
  ofTheWork,
  parseFindings,
  severitiesCount,
  type Finding,
} from '../findings';

describe('the findings of a review', () => {
  const findings: Finding[] = [
    {
      severity: 'major',
      summary: 'The limit is read before it is set',
      file: 'src/a.ts',
      line: 42,
    },
    { severity: 'nit', summary: 'A name could say more' },
    { severity: 'blocker', summary: 'The token is logged', file: 'src/log.ts' },
  ];

  it('are shown one to a line, with where they are', () => {
    expect(findings.map(findingLine)).toEqual([
      '[major] src/a.ts:42 - The limit is read before it is set',
      '[nit] A name could say more',
      '[blocker] src/log.ts - The token is logged',
    ]);
    expect(findingsCount(findings)).toBe('1 blocker, 1 major, 1 nit');
    expect(findingsCount([])).toBe('no findings');
  });

  it('weigh against a threshold', () => {
    expect(findings.filter((finding) => atLeast(finding, 'major')).map((f) => f.severity)).toEqual([
      'major',
      'blocker',
    ]);
    expect(findings.filter((finding) => atLeast(finding, 'nit'))).toHaveLength(3);
    expect(findings.filter((finding) => atLeast(finding, 'blocker'))).toHaveLength(1);
  });

  it('are read back from the lines they are shown as, among other text', () => {
    const report = [
      'I read the diff of job #4.',
      ...findings.map((finding) => `- ${findingLine(finding)}`),
      '* [MINOR] The retry waits - for nothing',
      '[minor] packages/x/y.test.ts:7 - no assertion',
      'Nothing else stands out.',
    ].join('\n');

    expect(parseFindings(report)).toEqual([
      ...findings,
      { severity: 'minor', summary: 'The retry waits - for nothing' },
      { severity: 'minor', summary: 'no assertion', file: 'packages/x/y.test.ts', line: 7 },
    ]);
  });

  it('are none when the reviewer says so, and unknown when the report names none', () => {
    expect(parseFindings('Looked at everything.\n[none]\nGood to go.')).toEqual([]);
    expect(parseFindings('Looks fine to me.')).toBeUndefined();
    expect(parseFindings('')).toBeUndefined();
  });

  it('are read from the forms agents write them in, and fit what a finding takes', () => {
    const report = [
      '1. **[major]** src/a.ts:42:7 - The limit is read before it is set',
      '2) [nit]: e.g. - a name could say more',
      '+ **[Blocker]** `rm -rf` runs before the check',
      `[minor] src/long.ts:1 - ${'x'.repeat(5_000)}`,
      '[minor]',
      '**[none]**',
    ].join('\n');

    const read = parseFindings(report) ?? [];
    expect(read.slice(0, 3)).toEqual([
      {
        severity: 'major',
        summary: 'The limit is read before it is set',
        file: 'src/a.ts',
        line: 42,
      },
      { severity: 'nit', summary: 'e.g. - a name could say more' },
      { severity: 'blocker', summary: '`rm -rf` runs before the check' },
    ]);
    expect(read[3]).toMatchObject({ severity: 'minor', file: 'src/long.ts', line: 1 });
    expect(read[3].summary).toHaveLength(2_000);
    expect(read).toHaveLength(4);
    expect(FindingsSchema.safeParse(read).success).toBe(true);
  });

  it('are one line each and of a known severity when they come as data', () => {
    expect(FindingsSchema.parse([{ severity: 'nit', summary: 'a\0b\u0007c' }])).toEqual([
      { severity: 'nit', summary: 'a b c' },
    ]);
    expect(
      FindingsSchema.parse([{ severity: 'major', summary: ' Two\nlines ', file: 'a.ts', line: 3 }])
    ).toEqual([{ severity: 'major', summary: 'Two lines', file: 'a.ts', line: 3 }]);
    expect(FindingsSchema.safeParse([{ severity: 'huge', summary: 'x' }]).success).toBe(false);
    expect(FindingsSchema.safeParse([{ severity: 'nit', summary: '  ' }]).success).toBe(false);
    expect(FindingsSchema.safeParse([{ severity: 'nit', summary: 'x', line: 0 }]).success).toBe(
      false
    );
  });

  it('keep what was noticed beside the job apart from what holds the work up', () => {
    const old: Finding = {
      severity: 'blocker',
      summary: 'The cache was never bounded',
      file: 'src/cache.ts',
      line: 9,
      beside: true,
    };
    const mixed = [
      ...findings,
      old,
      { severity: 'minor' as const, summary: 'A typo', beside: true },
    ];

    expect(findingLine(old)).toBe('[beside blocker] src/cache.ts:9 - The cache was never bounded');
    expect(findingsCount(mixed)).toBe('1 blocker, 1 major, 1 nit, 2 beside the job');
    expect(findingsCount([old])).toBe('1 beside the job');
    expect(severitiesCount(mixed)).toBe('2 blocker, 1 major, 1 minor, 1 nit');
    expect(mixed.filter(ofTheWork)).toEqual(findings);
    expect(mixed.filter((finding) => holdsUp(finding, 'major')).map((f) => f.summary)).toEqual([
      'The limit is read before it is set',
      'The token is logged',
    ]);
    expect(holdsUp(old, 'nit')).toBe(false);
    expect(FindingsSchema.parse([old])).toEqual([old]);
  });

  it('read the mark of a finding beside the job in the forms agents write it in', () => {
    const report = [
      '[beside blocker] src/cache.ts:9 - The cache was never bounded',
      '- **[major, beside]** src/old.ts - A retry that was always off by one',
      '2. [BESIDE minor]: A typo in a comment nobody touched',
      '[minor - beside] No test for the old path',
      '[major] src/new.ts:3 - The new limit is never read',
    ].join('\n');

    const read = parseFindings(report) ?? [];
    expect(read).toEqual([
      {
        severity: 'blocker',
        summary: 'The cache was never bounded',
        file: 'src/cache.ts',
        line: 9,
        beside: true,
      },
      {
        severity: 'major',
        summary: 'A retry that was always off by one',
        file: 'src/old.ts',
        beside: true,
      },
      { severity: 'minor', summary: 'A typo in a comment nobody touched', beside: true },
      { severity: 'minor', summary: 'No test for the old path', beside: true },
      { severity: 'major', summary: 'The new limit is never read', file: 'src/new.ts', line: 3 },
    ]);
    expect(parseFindings(read.map(findingLine).join('\n'))).toEqual(read);
  });
});
