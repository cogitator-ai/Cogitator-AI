import type {
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from '@cogitator-ai/types';

export type { ApprovalRequestedEvent, ApprovalResolvedEvent };

export interface ApprovalReplyWords {
  approveWords: readonly string[];
  denyWords: readonly string[];
}

export interface GatewayApprovalsConfig {
  /**
   * Builds the message asking to approve the paused tool calls.
   * Defaults to an English prompt listing each call with its arguments.
   */
  format?: (approvals: readonly ToolApprovalRequest[], words: ApprovalReplyWords) => string;
  /** Replies that approve every waiting call (case-insensitive, the whole message) */
  approveWords?: readonly string[];
  /** Replies that decline every waiting call; text after the word becomes the reason */
  denyWords?: readonly string[];
  /** Sent when someone other than the user who started the run answers it */
  notAllowedMessage?: string;
  /**
   * Put Approve and Deny buttons under the prompt on channels that have buttons (default
   * true). A press answers like the reply words do, and the buttons then show the decision.
   */
  buttons?: boolean;
  /** Labels of the buttons and of the decision they show once pressed */
  buttonLabels?: { approve?: string; deny?: string; approved?: string; denied?: string };
  /** Shown on a press of buttons whose request was answered, dropped or is from before a restart */
  expiredMessage?: string;
}

export const DEFAULT_EXPIRED_MESSAGE =
  'This request is no longer waiting. Reply "approve" or "deny" if it is still paused.';

/** The `data` of the approval buttons the gateway puts under its prompt. */
export const APPROVE_ACTION = 'cogitator:approve';
export const DENY_ACTION = 'cogitator:deny';

export const DEFAULT_APPROVE_WORDS: readonly string[] = ['approve', 'yes', 'да', 'одобряю'];
export const DEFAULT_DENY_WORDS: readonly string[] = ['deny', 'no', 'нет', 'отклоняю'];
export const DEFAULT_NOT_ALLOWED_MESSAGE =
  'Only the person who made this request can approve or deny it.';

const MAX_ARGS_CHARS = 300;
const LEADING_SEPARATORS = /^[\s\p{P}]+/u;
const WORD_BOUNDARY = /^[\s\p{P}]/u;

function normalizeWords(words: readonly string[]): string[] {
  return words
    .map((word) => word.trim().toLocaleLowerCase())
    .filter((word) => word.length > 0)
    .sort((a, b) => b.length - a.length);
}

function matchLeadingWord(text: string, words: readonly string[]): string | null {
  for (const word of normalizeWords(words)) {
    if (text.slice(0, word.length).toLocaleLowerCase() !== word) continue;
    const rest = text.slice(word.length);
    if (rest && !WORD_BOUNDARY.test(rest)) continue;
    return rest.replace(LEADING_SEPARATORS, '').trim();
  }
  return null;
}

/**
 * Reads a chat reply as an answer to waiting tool calls: an approve word on its
 * own approves them, a deny word declines them with any text after it as the reason.
 * Anything else is an ordinary message and yields `null`.
 */
export function parseApprovalReply(
  text: string,
  words: ApprovalReplyWords
): ToolApprovalDecision | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const afterApprove = matchLeadingWord(trimmed, words.approveWords);
  if (afterApprove === '') return { approved: true };

  const reason = matchLeadingWord(trimmed, words.denyWords);
  if (reason === null) return null;
  return reason ? { approved: false, reason } : { approved: false };
}

function compactArguments(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? '{}';
  } catch {
    json = '[unserializable arguments]';
  }
  const chars = [...json];
  return chars.length > MAX_ARGS_CHARS ? `${chars.slice(0, MAX_ARGS_CHARS).join('')}…` : json;
}

function quoteWords(words: readonly string[]): string {
  return words
    .slice(0, 2)
    .map((word) => `"${word}"`)
    .join(' or ');
}

export function formatApprovalPrompt(
  approvals: readonly ToolApprovalRequest[],
  words: ApprovalReplyWords
): string {
  const single = approvals.length === 1;
  const lines = [
    single
      ? 'I need your approval before running this action:'
      : `I need your approval before running these ${approvals.length} actions:`,
    '',
  ];

  approvals.forEach((approval, index) => {
    const title = `**${approval.toolName}**${approval.description ? ` — ${approval.description}` : ''}`;
    lines.push(single ? title : `${index + 1}. ${title}`);
    lines.push('```json', compactArguments(approval.arguments), '```');
  });

  lines.push(
    '',
    `Reply ${quoteWords(words.approveWords)} to allow ${single ? 'it' : 'them'}, ` +
      `or ${quoteWords(words.denyWords)} to refuse (you can add a reason after it).`
  );
  return lines.join('\n');
}
