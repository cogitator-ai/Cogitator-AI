import { z } from 'zod';

/**
 * How much a finding of a review weighs: a `blocker` must not go in as it is, a `major` one
 * should be fixed first, a `minor` one is worth fixing, a `nit` is a matter of taste.
 */
export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/** The severities, the heaviest first. */
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['blocker', 'major', 'minor', 'nit'];

/** One thing a review found. */
export interface Finding {
  severity: FindingSeverity;
  /** What is wrong, and what would be right */
  summary: string;
  /** The file it is in, from the top of the repository */
  file?: string;
  /** The line it is at */
  line?: number;
}

/** One line of plain text: breaks and control characters become spaces. */
const oneLine = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, ' ').trim();

/** The longest summary of a finding, and the longest path of its file. */
const MAX_SUMMARY = 2_000;
const MAX_FILE = 1_000;

export const FindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES as [FindingSeverity, ...FindingSeverity[]]),
  summary: z.string().transform(oneLine).pipe(z.string().min(1).max(MAX_SUMMARY)),
  file: z.string().transform(oneLine).pipe(z.string().min(1).max(MAX_FILE)).optional(),
  line: z.number().int().positive().max(10_000_000).optional(),
});

/** The most findings one report carries. */
export const MAX_FINDINGS = 100;

export const FindingsSchema = z.array(FindingSchema).max(MAX_FINDINGS);

/** Whether a finding weighs at least as much as `threshold`. */
export function atLeast(finding: Finding, threshold: FindingSeverity): boolean {
  return FINDING_SEVERITIES.indexOf(finding.severity) <= FINDING_SEVERITIES.indexOf(threshold);
}

/** One finding as a line: `[major] src/a.ts:42 - the limit is read before it is set`. */
export function findingLine(finding: Finding): string {
  const where = finding.file
    ? ` ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} -`
    : '';
  return `[${finding.severity}]${where} ${finding.summary}`;
}

/** How many findings there are of each severity, in words: `1 blocker, 2 major`. */
export function findingsCount(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'no findings';
  return FINDING_SEVERITIES.flatMap((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return count > 0 ? [`${count} ${severity}`] : [];
  }).join(', ');
}

/** A finding line: a list mark if any, the severity in brackets, bold or not, then the rest. */
const LINE = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?\*{0,2}\[(blocker|major|minor|nit)\]\*{0,2}:?\s*(.+)$/i;

/** Where a finding is, when its line names a place before ` - `: `src/a.ts:42 - ...`. */
const PLACE = /^(\S+?)(?::(\d+))?(?::\d+)?\s+-\s+(.+)$/;

/** Whether a word reads as a path: it has a folder in it, or ends like a file name. */
function looksLikeFile(word: string): boolean {
  return word.length <= MAX_FILE && (word.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(word));
}

/**
 * Reads findings out of a report written in words, for an agent that has no tool to name them
 * with: every line of the form `[severity] file:line - what is wrong`, with the file and the
 * line left out when the finding has none. A list mark before it and bold around the severity
 * are fine. Other lines are not findings. Undefined when the report holds no such line, which is
 * not the same as a review that found nothing: a reviewer that found nothing says so with a
 * line `[none]`, read as an empty list. What is read fits `FindingSchema`: a summary longer than
 * a finding takes is cut.
 */
export function parseFindings(report: string): Finding[] | undefined {
  const found: Finding[] = [];
  let said = false;
  for (const line of report.split(/\r?\n/)) {
    if (/^\s*(?:(?:[-*+]|\d+[.)])\s+)?\*{0,2}\[none\]/i.test(line)) {
      said = true;
      continue;
    }
    const match = LINE.exec(line);
    if (!match) continue;
    said = true;
    if (found.length >= MAX_FINDINGS) continue;
    const [, severity, rest] = match;
    const place = PLACE.exec(rest);
    const file = place && looksLikeFile(place[1]) ? place[1] : undefined;
    const summary = oneLine(file && place ? place[3] : rest).slice(0, MAX_SUMMARY);
    if (!summary) continue;
    found.push({
      severity: severity.toLowerCase() as FindingSeverity,
      summary,
      ...(file && { file }),
      ...(file && place?.[2] && { line: Number(place[2]) }),
    });
  }
  return said ? found : undefined;
}
