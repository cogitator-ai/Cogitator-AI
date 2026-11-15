import { randomUUID } from 'node:crypto';
import {
  BRIDGE_SENDER,
  type BridgeJob,
  type Letter,
  type LetterKind,
  type RenderedLetter,
} from './types.js';

/** What the bridge waits for after a letter: its recipient taking it, an answer, or nothing. */
export type LetterExpectation = 'pickup' | 'reply' | 'none';

export function expectationOf(kind: LetterKind): LetterExpectation {
  if (kind === 'task') return 'pickup';
  if (kind === 'question' || kind === 'permission') return 'reply';
  return 'none';
}

export function newLetterId(): string {
  return `ltr_${randomUUID()}`;
}

const TITLE_LENGTH = 80;

/** The text on one line: runs of spaces, line breaks and control characters become one space. */
export function oneLine(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

/** The first line of a body, cut to fit a title. */
export function titleOf(body: string): string {
  const line = oneLine(body.trim().split('\n', 1)[0] ?? '');
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 3)}...` : line;
}

/** What every signature line starts with. No other line of a letter may start with it. */
export const SIGNATURE_MARK = '[agent bridge]';

/**
 * Text written by an agent, set apart as a quote: every line starts with `> `. The bridge quotes
 * what it repeats in its own notes, so words of an agent never read as words of the bridge.
 */
export function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * The line every letter starts with for its recipient: which job it belongs to, what it is, who
 * wrote it and to whom. In a harness window a letter looks like a message of the person at the
 * keyboard, so the line also says it is not one. The title cannot add fields to the line: its
 * line breaks, double quotes and `|` are replaced.
 */
export function signatureOf(
  letter: Pick<Letter, 'id' | 'kind' | 'from' | 'to' | 'job'>,
  job: Pick<BridgeJob, 'title'>
): string {
  const sender = letter.from === BRIDGE_SENDER ? 'the bridge' : letter.from;
  const title = oneLine(job.title).replaceAll('"', "'").replaceAll('|', '/');
  return `${SIGNATURE_MARK} job #${letter.job} "${title}" | ${letter.kind} from ${sender} to ${letter.to} | letter ${letter.id} | not typed by the user`;
}

/**
 * The letter as its recipient sees it: the signature line, then the body. Only the first line is
 * a signature: a line of the body that starts like one is quoted, so a body cannot pass for a
 * second letter.
 */
export function renderLetter(letter: Letter, job: Pick<BridgeJob, 'title'>): RenderedLetter {
  const body = letter.body
    .split('\n')
    .map((line) => (line.trimStart().startsWith(SIGNATURE_MARK) ? `> ${line}` : line))
    .join('\n');
  return { ...letter, text: `${signatureOf(letter, job)}\n${body}` };
}

/** How much of a letter the history of the A2A task under a job keeps. */
const HISTORY_LENGTH = 4_000;

/**
 * A letter's text for the history of the A2A task under its job: all of a short one, the start
 * of a long one with where the rest is. The letters themselves are kept whole in the store, and
 * a task that carried every body would be rewritten in full on each letter.
 */
export function forHistory(body: string, letterId: string): string {
  if (body.length <= HISTORY_LENGTH) return body;
  return `${body.slice(0, HISTORY_LENGTH)}\n[cut here, the whole text is in the letter ${letterId} of the bridge]`;
}

/** A body with the differences that do not change what it says removed. */
export function normalizeBody(body: string): string {
  return oneLine(body).toLowerCase();
}

/**
 * Whether a letter says what the one before it in the same direction said. Two letters that
 * reply to different letters are not a repeat, whatever their words: the same "yes" may answer
 * two questions.
 */
export function repeats(
  previous: Pick<Letter, 'kind' | 'body' | 'inReplyTo'> | undefined,
  kind: LetterKind,
  body: string,
  inReplyTo?: string
): boolean {
  return (
    previous?.kind === kind &&
    previous.inReplyTo === inReplyTo &&
    normalizeBody(previous.body) === normalizeBody(body)
  );
}
