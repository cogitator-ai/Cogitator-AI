import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hasBridgeNotes, withBridgeNotes, withoutBridgeNotes } from '../tools/guidance.js';
import type { SetupStep } from './setup.js';

/** The text of a file, or undefined when it is not there. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * A settings file as an object: empty when the file is not there or holds nothing.
 *
 * @throws Error when the file is not a JSON object: it is never overwritten then
 */
export function readSettings(path: string): Record<string, unknown> {
  const text = readText(path);
  if (text === undefined || text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it first: nothing was changed`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} does not hold a JSON object. Fix it first: nothing was changed`);
  }
  return value as Record<string, unknown>;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Writes a settings file, or removes it when nothing is left in it. */
export function writeSettings(path: string, settings: Record<string, unknown>): void {
  if (Object.keys(settings).length === 0) rmSync(path, { force: true });
  else writeText(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The step that puts the notes of the bridge into an instructions file, or brings the notes it
 * has up to date. Undefined when the file has exactly these notes.
 */
export function notesStep(path: string, notes: string): SetupStep | undefined {
  const before = readText(path);
  const after = withBridgeNotes(before ?? '', notes);
  if (before === after) return undefined;
  const had = before !== undefined && hasBridgeNotes(before);
  return {
    title: `${had ? 'Update' : 'Add'} the notes of the bridge in ${path}${before === undefined ? ' (a new file)' : ''}`,
    lines: notes.split('\n').map((line) => `+ ${line}`),
    apply: async () => writeText(path, after),
  };
}

/**
 * The step that takes the notes of the bridge out of an instructions file. A file that held
 * nothing else is removed. Undefined when the file has no notes.
 */
export function removeNotesStep(path: string): SetupStep | undefined {
  const before = readText(path);
  const after = before === undefined ? undefined : withoutBridgeNotes(before);
  if (after === undefined) return undefined;
  const empty = after.trim() === '';
  return {
    title: empty
      ? `Remove ${path}, which holds only the notes of the bridge`
      : `Remove the notes of the bridge from ${path}`,
    lines: [],
    apply: async () => {
      if (empty) rmSync(path, { force: true });
      else writeText(path, after);
    },
  };
}
