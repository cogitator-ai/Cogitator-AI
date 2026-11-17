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

/** The most a line number of a finding may be. */
const MAX_LINE = 10_000_000;

export const FindingSchema = z.strictObject({
  severity: z.enum(FINDING_SEVERITIES as [FindingSeverity, ...FindingSeverity[]]),
  summary: z.string().transform(oneLine).pipe(z.string().min(1).max(MAX_SUMMARY)),
  file: z.string().transform(oneLine).pipe(z.string().min(1).max(MAX_FILE)).optional(),
  line: z.number().int().positive().max(MAX_LINE).optional(),
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

/** A line without the list mark it starts with: `- `, `* `, `1. `, `2) `. */
function withoutMark(line: string): string {
  const text = line.trimStart();
  const mark = /^(?:[-*+]|\d{1,9}[.)])\s/.exec(text);
  return mark ? text.slice(mark[0].length).trimStart() : text;
}

/** What a finding line starts with: the severity in brackets, bold or not, or `[none]`. */
const HEAD = /^\*{0,2}\[(blocker|major|minor|nit|none)\]\*{0,2}:?/i;

/** Whether a word reads as a path: it has a folder in it, or ends like a file name. */
function looksLikeFile(word: string): boolean {
  return word.length <= MAX_FILE && (word.includes('/') || /\.[A-Za-z0-9]{1,10}$/.test(word));
}

/**
 * Where a finding is, when what follows its severity names a place before ` - `:
 * `src/a.ts:42 - ...`, with a column after the line or without either.
 */
function placeOf(rest: string): { file: string; line?: number; summary: string } | undefined {
  const gap = rest.search(/\s/);
  if (gap <= 0) return undefined;
  const after = rest.slice(gap).trimStart();
  if (!after.startsWith('-') || !/^\s/.test(after.slice(1))) return undefined;
  let word = rest.slice(0, gap);
  const numbers: number[] = [];
  while (numbers.length < 2) {
    const colon = word.lastIndexOf(':');
    const tail = colon > 0 ? word.slice(colon + 1) : '';
    if (!/^\d{1,9}$/.test(tail)) break;
    numbers.unshift(Number(tail));
    word = word.slice(0, colon);
  }
  if (!looksLikeFile(word)) return undefined;
  const line = numbers[0];
  return {
    file: word,
    ...(line !== undefined && line >= 1 && line <= MAX_LINE && { line }),
    summary: after.slice(1),
  };
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
    const text = withoutMark(line);
    const head = HEAD.exec(text);
    if (!head) continue;
    said = true;
    const severity = head[1].toLowerCase();
    if (severity === 'none' || found.length >= MAX_FINDINGS) continue;
    const rest = text.slice(head[0].length).trim();
    const place = placeOf(rest);
    const summary = oneLine(place ? place.summary : rest).slice(0, MAX_SUMMARY);
    if (!summary) continue;
    found.push({
      severity: severity as FindingSeverity,
      summary,
      ...(place && { file: place.file }),
      ...(place?.line !== undefined && { line: place.line }),
    });
  }
  return said ? found : undefined;
}
