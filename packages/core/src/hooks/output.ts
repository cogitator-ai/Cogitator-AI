/**
 * What a hook handler answered: its exit code, stdout and stderr read the way Claude Code reads
 * them
 */

import { z } from 'zod';

const InputRecord = z.record(z.string(), z.unknown());

/** The JSON a hook prints on stdout (or an HTTP hook answers with), the fields Cogitator reads */
export const HookOutputSchema = z.looseObject({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  decision: z.enum(['block', 'approve']).optional(),
  reason: z.string().optional(),
  hookSpecificOutput: z
    .looseObject({
      hookEventName: z.string().optional(),
      permissionDecision: z.enum(['allow', 'deny', 'ask', 'defer']).optional(),
      permissionDecisionReason: z.string().optional(),
      updatedInput: InputRecord.optional(),
      additionalContext: z.string().optional(),
      decision: z
        .looseObject({
          behavior: z.enum(['allow', 'deny']),
          updatedInput: InputRecord.optional(),
          updatedPermissions: z.array(z.unknown()).optional(),
          message: z.string().optional(),
          interrupt: z.boolean().optional(),
        })
        .optional(),
      updatedToolOutput: z.unknown().optional(),
      updatedMCPToolOutput: z.unknown().optional(),
    })
    .optional(),
});

export type HookOutput = z.infer<typeof HookOutputSchema>;

/** The answer of a `prompt` hook's model */
export const PromptAnswerSchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().optional(),
    impossible: z.boolean().optional(),
  })
  .refine((answer) => answer.ok || (answer.reason !== undefined && answer.reason.trim() !== ''), {
    message: 'reason is required when ok is false',
  });

export type PromptAnswer = z.infer<typeof PromptAnswerSchema>;

/** What stdout holds: one JSON object, plain text, or text that tried to be JSON and failed */
export type ReadStdout =
  | { kind: 'json'; output: HookOutput }
  | { kind: 'text'; text: string }
  | { kind: 'invalid'; error: string };

/**
 * Reads a hook's stdout as Claude Code does: one JSON object with nothing but whitespace around
 * it is JSON output, checked against the output schema. Anything that does not start with `{` and
 * end with `}` is plain text. Lines that each parse as JSON are plain text unless one of them sets
 * an output field, which makes the whole a parse failure
 */
export function readStdout(stdout: string): ReadStdout {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return { kind: 'text', text: trimmed };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const lines = trimmed.split('\n').filter((line) => line.trim() !== '');
    if (lines.length > 1 && lines.every(parsesAsJson)) {
      const setsField = lines.some((line) => {
        const value: unknown = JSON.parse(line);
        return (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          Object.keys(HookOutputSchema.shape).some((key) => Object.hasOwn(value, key))
        );
      });
      if (!setsField) return { kind: 'text', text: trimmed };
      return {
        kind: 'invalid',
        error: 'stdout holds several JSON values, print one JSON object and nothing else',
      };
    }
    return {
      kind: 'invalid',
      error: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const checked = HookOutputSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return {
      kind: 'invalid',
      error: `the JSON output does not match the hook output schema: ${issue ? `${issue.path.join('.') || 'value'} ${issue.message}` : 'invalid'}`,
    };
  }
  return { kind: 'json', output: checked.data };
}

function parsesAsJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

/** The JSON object in a model's answer: the whole text, else the first fenced or braced block */
export function jsonInAnswer(text: string): unknown {
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Most characters of a hook's context, system message or plain stdout, as in Claude Code */
export const HOOK_TEXT_LIMIT = 10_000;

/** `text` within {@link HOOK_TEXT_LIMIT}, with a note of what was cut */
export function capHookText(text: string): string {
  if (text.length <= HOOK_TEXT_LIMIT) return text;
  return `${text.slice(0, HOOK_TEXT_LIMIT)}\n[... ${text.length - HOOK_TEXT_LIMIT} more characters of the hook's output were cut]`;
}

/** The first line of `text`, for a short notice */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}
