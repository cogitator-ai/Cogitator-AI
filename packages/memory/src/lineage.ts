/**
 * Lineage of derived memory - checking that summaries, facts and observations stand on what the
 * conversation actually said
 */

import type {
  ContentPart,
  Evidence,
  EvidenceStatus,
  MemoryAdapter,
  MemoryEntry,
  MemoryResult,
} from '@cogitator-ai/types';

/** Text compared without the whitespace differences a model introduces when it quotes */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

/**
 * The texts a quote of `evidence` may come from in `entry`: the message text, and the results
 * of its tool calls as JSON. With a `toolCallId`, only the result of that call.
 */
function sourcesIn(entry: MemoryEntry, evidence: Evidence): string[] {
  const results = (entry.toolResults ?? []).filter(
    (result) => evidence.toolCallId === undefined || result.callId === evidence.toolCallId
  );
  const resultTexts = results.flatMap((result): string[] => {
    const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
    return text === undefined ? [] : [text];
  });
  if (evidence.toolCallId !== undefined) {
    const answers = entry.message.toolCallId === evidence.toolCallId;
    return answers ? [textOf(entry.message.content), ...resultTexts] : resultTexts;
  }
  return [textOf(entry.message.content), ...resultTexts];
}

/**
 * Whether the quote of `evidence` appears in `entry` word for word, whitespace aside: in its
 * text, or in the result of the tool call it names. A quote that does not is `suggested`: kept,
 * but not to be relied on as fact.
 */
export function verifyEvidence(evidence: Evidence, entry: MemoryEntry): EvidenceStatus {
  const quote = normalized(evidence.quote);
  if (quote.length === 0) return 'suggested';
  return sourcesIn(entry, evidence).some((text) => normalized(text).includes(quote))
    ? 'verified'
    : 'suggested';
}

/**
 * Whether every piece of `evidence` lies on a branch: its entries are among `pathIds`. Evidence
 * that names a file and no entry does not depend on the branch.
 */
export function evidenceOnPath(
  evidence: readonly Evidence[],
  pathIds: ReadonlySet<string>
): boolean {
  return evidence.every((item) => item.entryId === undefined || pathIds.has(item.entryId));
}

/** A piece of evidence with what checking it against memory found */
export interface CheckedEvidence extends Evidence {
  status: EvidenceStatus;
}

/**
 * Checks each piece of evidence against the entry it names in `memory`. Evidence of an entry
 * that is gone is `suggested`, as is evidence that names no entry: a file is not memory's to
 * check. The whole is `verified` only when every piece is.
 */
export async function verifyEvidenceInMemory(
  memory: Pick<MemoryAdapter, 'getEntry'>,
  evidence: readonly Evidence[]
): Promise<MemoryResult<{ status: EvidenceStatus; evidence: CheckedEvidence[] }>> {
  const checked: CheckedEvidence[] = [];
  for (const item of evidence) {
    if (item.entryId === undefined) {
      checked.push({ ...item, status: 'suggested' });
      continue;
    }
    const found = await memory.getEntry(item.entryId);
    if (!found.success) return found;
    checked.push({
      ...item,
      status: found.data ? verifyEvidence(item, found.data) : 'suggested',
    });
  }
  const status: EvidenceStatus =
    checked.length > 0 && checked.every((item) => item.status === 'verified')
      ? 'verified'
      : 'suggested';
  return { success: true, data: { status, evidence: checked } };
}
