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
import { verifyEvidence } from './lineage';
import { countEntryTokens } from './token-counter';

/** Kinds a summary must not lose while they are open: what is still to do, decided or wrong */
export const CONTROL_KINDS: ReadonlySet<CompactionAtomKind> = new Set([
  'task',
  'decision',
  'constraint',
  'error',
  'file',
  'thread',
]);

/** What a chapter model is asked for, given the numbered transcript of a window */
export const CHAPTER_PROMPT = `You compact a part of a conversation into what a reader needs to go on with it.
The transcript numbers each message as [n]. Answer with a JSON array only, no other text. Each item:
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

/** The transcript of `window` a chapter model reads, each message numbered by its place */
export function chapterTranscript(window: readonly MemoryEntry[]): string {
  return window
    .map((entry, at) => {
      const role =
        entry.message.role === 'tool'
          ? `tool ${entry.message.name ?? ''}`.trim()
          : entry.message.role;
      const calls = (entry.toolCalls ?? [])
        .map((call) => ` [calls ${call.name} ${JSON.stringify(call.arguments)}]`)
        .join('');
      return `[${at}] ${role}: ${textOf(entry.message.content)}${calls}`;
    })
    .join('\n');
}

/**
 * The atoms of a chapter model's `answer` about `window`: its JSON array, each quote tied to the
 * entry it names and checked against it. Undefined when the answer holds no valid array.
 */
export function parseChapter(
  answer: string,
  window: readonly MemoryEntry[]
): CompactionAtom[] | undefined {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const parsed = z.array(atomSchema).safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data.map((item) => {
    const evidence: Evidence[] = [];
    let verified = item.evidence.length > 0;
    for (const quote of item.evidence) {
      const entry = window[quote.message];
      if (!entry) {
        verified = false;
        continue;
      }
      const piece: Evidence = { entryId: entry.id, quote: quote.quote };
      evidence.push(piece);
      if (verifyEvidence(piece, entry) !== 'verified') verified = false;
    }
    return { kind: item.kind, status: item.status, text: item.text, evidence, verified };
  });
}

const FILE_ARGUMENT = /^(path|file|filepath|file_path|filename|dir|directory)$/i;
const OPEN_TASK_LINE = /^\s*(?:[-*]\s*\[ \]|TODO\b[:\s])/i;

/**
 * The control atoms `window` holds in its structure, which need no model and are not lost:
 * files tool calls worked on, tool calls that failed, and open task lines (`TODO`, `- [ ]`)
 */
export function structuralAtoms(window: readonly MemoryEntry[]): CompactionAtom[] {
  const atoms: CompactionAtom[] = [];
  for (const entry of window) {
    for (const call of entry.toolCalls ?? []) atoms.push(...fileAtoms(entry, call));
    for (const result of entry.toolResults ?? []) {
      if (!result.error) continue;
      atoms.push({
        kind: 'error',
        status: 'open',
        text: `${result.name} failed: ${result.error}`,
        evidence: [{ entryId: entry.id, toolCallId: result.callId, quote: result.error }],
        verified: true,
      });
    }
    for (const line of textOf(entry.message.content).split('\n')) {
      if (!OPEN_TASK_LINE.test(line)) continue;
      const evidence: Evidence = { entryId: entry.id, quote: line.trim() };
      atoms.push({
        kind: 'task',
        status: 'open',
        text: line.trim(),
        evidence: [evidence],
        verified: verifyEvidence(evidence, entry) === 'verified',
      });
    }
  }
  return atoms;
}

function fileAtoms(entry: MemoryEntry, call: ToolCall): CompactionAtom[] {
  return Object.entries(call.arguments).flatMap(([name, value]) =>
    FILE_ARGUMENT.test(name) && typeof value === 'string' && value.trim()
      ? [
          {
            kind: 'file' as const,
            status: 'open' as const,
            text: value.trim(),
            evidence: [{ entryId: entry.id, toolCallId: call.id, quote: value.trim() }],
            verified: true,
          },
        ]
      : []
  );
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
 * every node. A later status wins, except that an open control atom is closed only by a later
 * atom whose evidence holds, so an unsupported claim of done does not drop it.
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
      const unsupportedClose =
        known.status === 'open' &&
        atom.status === 'closed' &&
        CONTROL_KINDS.has(atom.kind) &&
        !atom.verified;
      merged.set(key, {
        ...known,
        status: unsupportedClose ? 'open' : atom.status,
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

/**
 * `levels` with chapters beyond `chaptersPerArc` folded into arcs, oldest first, and arcs
 * beyond `arcsPerSaga` folded into the saga. Folding needs no model, so it loses nothing.
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
    saga = foldNodes([...(saga ? [saga] : []), ...arcs.splice(0, arcsPerSaga)]);
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
