/**
 * Hierarchical compaction - a summary kept as a tree of grounded atoms: chapters written by a
 * model from windows of the conversation, folded without one into arcs and a saga
 */

import { z } from 'zod';
import type {
  CompactionAtom,
  CompactionAtomKind,
  CompactionLevels,
  CompactionNode,
  ContentPart,
  Evidence,
  MemoryEntry,
  ToolCall,
} from '@cogitator-ai/types';
import { findAnswerArray } from './answer-array';
import { verifyEvidence } from './lineage';
import { countEntryTokens } from './token-counter';

/** Kinds a summary must not lose while they are open: what is still to do, decided or wrong */
export const CONTROL_KINDS: ReadonlySet<CompactionAtomKind> = new Set([
  'task',
  'decision',
  'constraint',
  'error',
  'thread',
]);

/** What a chapter model is asked for, given the numbered transcript of a window */
export const CHAPTER_PROMPT = `You compact a part of a conversation into what a reader needs to go on with it.
The transcript numbers each message as [n] at the start of a line, its further lines indented.
Answer with a JSON array only, no other text. Each item:
{"kind": "fact" | "task" | "decision" | "constraint" | "error" | "file" | "thread",
 "status": "open" | "closed",
 "text": "one short sentence",
 "evidence": [{"message": n, "quote": "words copied exactly from message n"}]}
- fact: something true about the user, the world or the work
- task: something asked or planned, open until done
- decision: a choice that was made, with its reason when given
- constraint: a rule or preference to keep following
- error: something that failed, open until fixed
- file: a file or resource worked on
- thread: a question or topic left unanswered
Quote the shortest exact words that show the item. Leave out small talk.`;

const atomSchema = z.object({
  kind: z.enum(['fact', 'task', 'decision', 'constraint', 'error', 'file', 'thread']),
  status: z.enum(['open', 'closed']).default('open'),
  text: z.string().trim().min(1),
  evidence: z
    .array(z.object({ message: z.number().int().nonnegative(), quote: z.string() }))
    .default([]),
});

function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

/**
 * The transcript of `window` a chapter model reads: each message numbered by its place, its
 * further lines indented so no text in it can pass for another message, and cut at about
 * `entryTokens` tokens so one huge output does not overflow the summarizer
 */
export function chapterTranscript(
  window: readonly MemoryEntry[],
  entryTokens = Number.POSITIVE_INFINITY,
  /** A note after the role of an entry, such as the date it was written */
  noteOf?: (entry: MemoryEntry) => string | undefined
): string {
  const room = entryTokens * 4;
  return window
    .map((entry, at) => {
      const role =
        entry.message.role === 'tool'
          ? `tool ${entry.message.name ?? ''}`.trim()
          : entry.message.role;
      const calls = (entry.toolCalls ?? [])
        .map((call) => ` [calls ${call.name} ${JSON.stringify(call.arguments)}]`)
        .join('');
      const whole = `${textOf(entry.message.content)}${calls}`;
      const text =
        whole.length > room
          ? `${whole.slice(0, room)} [${whole.length - room} more characters cut]`
          : whole;
      const note = noteOf?.(entry);
      return `[${at}] ${role}${note ? ` (${note})` : ''}: ${text.replace(/\n/g, '\n    ')}`;
    })
    .join('\n');
}

/**
 * The part of a chapter prompt that lists `open` control atoms of earlier chapters, so the model
 * can close the ones this window shows done, answered or fixed
 */
export function openItemsPrompt(open: readonly CompactionAtom[]): string {
  if (open.length === 0) return '';
  const items = open.map((atom) => `- ${atom.kind}: ${atom.text}`).join('\n');
  return `Still open from before this part:\n${items}\nWhen this part shows one of them done, answered or fixed, list it with status "closed", its kind and text exactly as given, and the quote that shows it.`;
}

/** Kinds that steer what comes next, which a tool output alone cannot ground */
const SPOKEN_KINDS: ReadonlySet<CompactionAtomKind> = new Set(['constraint', 'decision']);

/**
 * The atoms of a chapter model's `answer` about `window`: its JSON array, each quote tied to the
 * entry it names and checked against it. A constraint or a decision that only a tool output
 * shows is not verified, so text a tool fetched does not become a rule. The array is found past
 * text and brackets around it, an element that is not an atom is left out instead of the whole
 * answer, and of an answer cut at its length limit inside the array the atoms it finished are
 * kept. Undefined when the answer holds no array of atoms.
 */
export function parseChapter(
  answer: string,
  window: readonly MemoryEntry[]
): CompactionAtom[] | undefined {
  return readChapter(answer, window)?.atoms;
}

/**
 * {@link parseChapter} with whether the answer was cut inside its array, so the chapter model can
 * be asked to go on after the last atom
 */
export function readChapter(
  answer: string,
  window: readonly MemoryEntry[]
): { atoms: CompactionAtom[]; cut: boolean } | undefined {
  const found = findAnswerArray(answer);
  if (!found) return undefined;
  const atoms = found.values.flatMap((value) => {
    const parsed = atomSchema.safeParse(value);
    return parsed.success ? [checkedAtom(parsed.data, window)] : [];
  });
  return { atoms, cut: found.cut };
}

/** An atom as the model wrote it, its quotes tied to the entries of `window` and checked */
function checkedAtom(
  item: z.infer<typeof atomSchema>,
  window: readonly MemoryEntry[]
): CompactionAtom {
  const evidence: Evidence[] = [];
  let verified = item.evidence.length > 0;
  let spoken = false;
  for (const quote of item.evidence) {
    const entry = window[quote.message];
    if (!entry) {
      verified = false;
      continue;
    }
    const piece: Evidence = { entryId: entry.id, quote: quote.quote };
    evidence.push(piece);
    if (verifyEvidence(piece, entry) !== 'verified') verified = false;
    if (entry.message.role !== 'tool') spoken = true;
  }
  if (SPOKEN_KINDS.has(item.kind) && !spoken) verified = false;
  return { kind: item.kind, status: item.status, text: item.text, evidence, verified };
}

/**
 * Times the chapter model is asked to go on with a window whose answer its length limit cut, so
 * a dense window is summarized whole
 */
export const CHAPTER_CONTINUATIONS = 4;

/** What the chapter model is asked after an answer that was cut, `count` atoms in, the last `last` */
export function chapterContinuationPrompt(count: number, last: string): string {
  return `Your answer was cut off at its length limit after ${count} items, the last one: ${JSON.stringify(last)}. Go on with the items of the transcript that come after it, in the same form. Answer with a JSON array of those items only, no other text, and close the array.`;
}

const FILE_ARGUMENT = /^(path|file|filepath|file_path|filename|dir|directory)$/i;
const TODO_LINE = /^\s*TODO\b[:\s]/i;
const CHECKBOX_LINE = /^\s*[-*]\s*\[( |x)\]\s*(\S.*)$/i;

/** The files a tool call works on: its string arguments named like a path */
function filesOf(call: ToolCall): string[] {
  return Object.entries(call.arguments).flatMap(([name, value]) =>
    FILE_ARGUMENT.test(name) && typeof value === 'string' && value.trim() ? [value.trim()] : []
  );
}

/** The longest argument signature a failure text carries */
const SIGNATURE_CHARS = 120;

/** `value` with the keys of every object in it sorted, so equal arguments read the same */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortedKeys(item)])
  );
}

/**
 * How the text of a failure of `call` opens: its tool and the files it worked on, or its
 * arguments when it names no files, so failures of different calls stay apart and a later call
 * on the same files or with the same arguments knows which one it closes
 */
function failureOf(call: ToolCall): string {
  const files = filesOf(call);
  const args =
    Object.keys(call.arguments).length > 0 ? JSON.stringify(sortedKeys(call.arguments)) : '';
  const subject =
    files.length > 0
      ? files.join(' ')
      : args.length > SIGNATURE_CHARS
        ? `${args.slice(0, SIGNATURE_CHARS)}...`
        : args;
  return `${[call.name, subject].filter(Boolean).join(' ')} failed: `;
}

/**
 * The control atoms `entries` hold in their structure, which need no model and are not lost:
 * files tool calls worked on, tool calls that failed, and task lines (`TODO`, `- [ ]`, closed by
 * a `- [x]` of the same task). A failed call is closed by a later call of the same tool that
 * succeeds on the same files, or with the same arguments when it names no files, whether the
 * failure is among `entries` or an open atom of `open`. `context` holds the entries the calls of
 * the results may be in (`entries` by default), a result whose call is not there closes nothing.
 */
export function structuralAtoms(
  entries: readonly MemoryEntry[],
  options: { context?: readonly MemoryEntry[]; open?: readonly CompactionAtom[] } = {}
): CompactionAtom[] {
  const calls = new Map(
    (options.context ?? entries).flatMap((entry) =>
      (entry.toolCalls ?? []).map((call) => [call.id, call] as const)
    )
  );
  const failures = (options.open ?? [])
    .filter((atom) => atom.kind === 'error' && atom.status === 'open')
    .map((atom) => atom.text);
  const atoms: CompactionAtom[] = [];
  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) {
      for (const file of filesOf(call)) {
        atoms.push({
          kind: 'file',
          status: 'open',
          text: file,
          evidence: [{ entryId: entry.id, toolCallId: call.id, quote: file }],
          verified: true,
        });
      }
    }
    for (const result of entry.toolResults ?? []) {
      const call = calls.get(result.callId);
      const failure = call ? failureOf(call) : `${result.name} failed: `;
      const evidence: Evidence = {
        entryId: entry.id,
        toolCallId: result.callId,
        quote: result.error ?? result.name,
      };
      if (result.error) {
        const text = failure + result.error;
        failures.push(text);
        atoms.push({ kind: 'error', status: 'open', text, evidence: [evidence], verified: true });
        continue;
      }
      if (!call) continue;
      for (const text of failures.filter((known) => known.startsWith(failure))) {
        atoms.push({ kind: 'error', status: 'closed', text, evidence: [evidence], verified: true });
      }
    }
    for (const line of textOf(entry.message.content).split('\n')) {
      const checkbox = CHECKBOX_LINE.exec(line);
      if (!checkbox && !TODO_LINE.test(line)) continue;
      const evidence: Evidence = { entryId: entry.id, quote: line.trim() };
      atoms.push({
        kind: 'task',
        status: checkbox?.[1]?.toLowerCase() === 'x' ? 'closed' : 'open',
        text: checkbox?.[2]?.trim() ?? line.trim(),
        evidence: [evidence],
        verified: verifyEvidence(evidence, entry) === 'verified',
      });
    }
  }
  return atoms;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The identity of an atom across chapters: its kind and its text */
export function atomKey(atom: Pick<CompactionAtom, 'kind' | 'text'>): string {
  return `${atom.kind}:${normalized(atom.text)}`;
}

function mergedEvidence(a: Evidence[] = [], b: Evidence[] = []): Evidence[] {
  const seen = new Set(a.map((piece) => `${piece.entryId}\u0000${piece.quote}`));
  return [...a, ...b.filter((piece) => !seen.has(`${piece.entryId}\u0000${piece.quote}`))];
}

/**
 * The atoms of `nodes`, oldest first, merged: one atom per kind and text, with the evidence of
 * every node. A later status wins, except that a control atom is closed or opened again only by
 * a later atom whose evidence holds, so an unsupported claim of done does not drop an item and an
 * unsupported repeat does not bring back one that was done.
 */
export function mergeAtoms(nodes: readonly CompactionNode[]): CompactionAtom[] {
  const merged = new Map<string, CompactionAtom>();
  for (const node of nodes) {
    for (const atom of node.atoms) {
      const key = atomKey(atom);
      const known = merged.get(key);
      if (!known) {
        merged.set(key, { ...atom, evidence: mergedEvidence(atom.evidence) });
        continue;
      }
      const unsupported =
        known.status !== atom.status && CONTROL_KINDS.has(atom.kind) && !atom.verified;
      merged.set(key, {
        ...known,
        status: unsupported ? known.status : atom.status,
        evidence: mergedEvidence(known.evidence, atom.evidence),
        verified: known.verified || atom.verified,
      });
    }
  }
  return [...merged.values()];
}

/** One node for `nodes`, oldest first: the range they cover and their atoms merged */
export function foldNodes(nodes: readonly CompactionNode[]): CompactionNode {
  const first = nodes[0];
  const last = nodes.at(-1);
  if (!first || !last) throw new Error('Nothing to fold');
  return { from: first.from, to: last.to, atoms: mergeAtoms(nodes) };
}

/** Atoms the saga keeps besides its open control atoms, the newest of them */
export const SAGA_ATOMS = 200;

/**
 * `node` as the saga keeps it, so the handoff stops growing: every open control atom, and of the
 * facts and files the newest {@link SAGA_ATOMS}, with no item done long ago
 */
function sagaOf(node: CompactionNode): CompactionNode {
  const open = (atom: CompactionAtom) => CONTROL_KINDS.has(atom.kind) && atom.status === 'open';
  const rest = node.atoms.filter(
    (atom) => !open(atom) && (atom.kind === 'fact' || atom.status === 'open')
  );
  const kept = new Set(rest.slice(-SAGA_ATOMS));
  return { ...node, atoms: node.atoms.filter((atom) => open(atom) || kept.has(atom)) };
}

/**
 * `levels` with chapters beyond `chaptersPerArc` folded into arcs, oldest first, and arcs
 * beyond `arcsPerSaga` folded into the saga, which drops items done and keeps the newest
 * {@link SAGA_ATOMS} other atoms. Folding needs no model and never loses an open control atom.
 */
export function foldLevels(
  levels: CompactionLevels,
  chaptersPerArc: number,
  arcsPerSaga: number
): CompactionLevels {
  const chapters = [...levels.chapters];
  const arcs = [...levels.arcs];
  let saga = levels.saga;
  while (chapters.length > chaptersPerArc) arcs.push(foldNodes(chapters.splice(0, chaptersPerArc)));
  while (arcs.length > arcsPerSaga) {
    saga = sagaOf(foldNodes([...(saga ? [saga] : []), ...arcs.splice(0, arcsPerSaga)]));
  }
  return { ...(saga && { saga }), arcs, chapters };
}

/** Every node of `levels`, oldest first */
export function nodesOf(levels: CompactionLevels): CompactionNode[] {
  return [...(levels.saga ? [levels.saga] : []), ...levels.arcs, ...levels.chapters];
}

/**
 * The control atoms of `before` that `after` lost: open in `before` and in `after` neither
 * still there nor closed by an atom whose evidence holds
 */
export function lostControls(before: CompactionLevels, after: CompactionLevels): CompactionAtom[] {
  const now = new Map(mergeAtoms(nodesOf(after)).map((atom) => [atomKey(atom), atom]));
  return mergeAtoms(nodesOf(before)).filter(
    (atom) => CONTROL_KINDS.has(atom.kind) && atom.status === 'open' && !now.has(atomKey(atom))
  );
}

const SECTIONS: { title: string; pick: (atom: CompactionAtom) => boolean }[] = [
  { title: 'Open tasks', pick: (atom) => atom.kind === 'task' && atom.status === 'open' },
  { title: 'Constraints', pick: (atom) => atom.kind === 'constraint' },
  { title: 'Decisions', pick: (atom) => atom.kind === 'decision' },
  { title: 'Unresolved errors', pick: (atom) => atom.kind === 'error' && atom.status === 'open' },
  { title: 'Open questions', pick: (atom) => atom.kind === 'thread' && atom.status === 'open' },
  { title: 'Files', pick: (atom) => atom.kind === 'file' },
  { title: 'Facts', pick: (atom) => atom.kind === 'fact' },
  { title: 'Done', pick: (atom) => atom.status === 'closed' && atom.kind !== 'fact' },
];

/**
 * The handoff a hierarchical summary is read as: its atoms merged and laid out by what a reader
 * goes on with, in the same order every time, so a summary that did not change reads the same
 * and keeps the prompt cache. An atom whose evidence did not hold is marked as unverified.
 */
export function renderHandoff(levels: CompactionLevels): string {
  const atoms = mergeAtoms(nodesOf(levels));
  const sections = SECTIONS.flatMap(({ title, pick }) => {
    const lines = atoms
      .filter(pick)
      .map((atom) => `- ${atom.text}${atom.verified ? '' : ' (unverified)'}`);
    return lines.length > 0 ? [`## ${title}\n${lines.join('\n')}`] : [];
  });
  return sections.join('\n\n');
}

/**
 * `entries` cut into windows of about `tokens` each, in order, each window opening with the last
 * entries of the one before (about a tenth of `tokens`) so what spans a cut is read whole
 */
export function chapterWindows(
  entries: readonly MemoryEntry[],
  tokens: number
): { window: MemoryEntry[]; own: MemoryEntry[] }[] {
  const windows: { window: MemoryEntry[]; own: MemoryEntry[] }[] = [];
  let own: MemoryEntry[] = [];
  let used = 0;
  const close = () => {
    if (own.length === 0) return;
    const previous = windows.at(-1)?.own ?? [];
    const overlap: MemoryEntry[] = [];
    let overlapTokens = 0;
    for (let at = previous.length - 1; at >= 0; at--) {
      const entry = previous[at]!;
      overlapTokens += countEntryTokens(entry);
      if (overlapTokens > tokens / 10) break;
      overlap.unshift(entry);
    }
    windows.push({ window: [...overlap, ...own], own });
    own = [];
    used = 0;
  };
  for (const entry of entries) {
    const size = countEntryTokens(entry);
    if (used + size > tokens && own.length > 0) close();
    own.push(entry);
    used += size;
  }
  close();
  return windows;
}
