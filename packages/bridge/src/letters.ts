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

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The first line of a body, cut to fit a title. */
export function titleOf(body: string): string {
  const line = oneLine(body.trim().split('\n', 1)[0] ?? '');
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 3)}...` : line;
}

/**
 * The line every letter starts with for its recipient: which job it belongs to, what it is, who
 * wrote it and to whom. In a harness window a letter looks like a message of the person at the
 * keyboard, so the line also says it is not one.
 */
export function signatureOf(
  letter: Pick<Letter, 'id' | 'kind' | 'from' | 'to' | 'job'>,
  job: Pick<BridgeJob, 'title'>
): string {
  const sender = letter.from === BRIDGE_SENDER ? 'the bridge' : letter.from;
  const title = oneLine(job.title).replaceAll('"', "'");
  return `[agent bridge] job #${letter.job} "${title}" | ${letter.kind} from ${sender} to ${letter.to} | letter ${letter.id} | not typed by the user`;
}

/** The letter as its recipient sees it: the signature line, then the body. */
export function renderLetter(letter: Letter, job: Pick<BridgeJob, 'title'>): RenderedLetter {
  return { ...letter, text: `${signatureOf(letter, job)}\n${letter.body}` };
}

/** A body with the differences that do not change what it says removed. */
export function normalizeBody(body: string): string {
  return oneLine(body).toLowerCase();
}

/** Whether a letter says what the one before it in the same direction said. */
export function repeats(
  previous: Pick<Letter, 'kind' | 'body'> | undefined,
  kind: LetterKind,
  body: string
): boolean {
  return previous?.kind === kind && normalizeBody(previous.body) === normalizeBody(body);
}
