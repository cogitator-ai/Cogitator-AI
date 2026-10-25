import type { SubagentDefinition, Tool } from '@cogitator-ai/types';
import {
  isUnmappedClaudeName,
  parseRule,
  ruleTarget,
  targetCovers,
  type RuleTarget,
} from '../permissions/rules';

/** Tools of the run itself that a subagent keeps whatever its lists say */
const ALWAYS_KEPT = new Set(['exit_plan_mode', 'tool_search']);

/** The tools that go with delegating: they come and go with the `agent` tool */
const DELEGATION_COMPANIONS = new Set(['send_message', 'task_output', 'task_stop']);

/** Which tools a subagent gets of the ones its run would have, from its `tools` and `disallowedTools` */
export interface ToolPolicy {
  allows(tool: Tool): boolean;
  /** Entries that name no tool of `pool`, so the subagent cannot get what they ask for */
  unresolved(pool: readonly Tool[]): string[];
  /** Entries that could not be read as a tool name or rule */
  readonly invalid: readonly string[];
  /** Whether `tools` was given and names none of `pool` */
  empty(pool: readonly Tool[]): boolean;
}

interface Entry {
  text: string;
  target?: RuleTarget;
}

function entriesOf(list: readonly string[] | undefined, invalid: string[]): Entry[] {
  return (list ?? []).map((text) => {
    const parsed = parseRule(text);
    if ('error' in parsed) {
      invalid.push(text);
      return { text };
    }
    if (isUnmappedClaudeName(parsed.tool)) return { text };
    const target = ruleTarget({ text: parsed.text, tool: parsed.tool }, 'deny');
    if ('error' in target) {
      invalid.push(text);
      return { text };
    }
    return { text, target };
  });
}

function covers(entry: Entry, tool: Tool): boolean {
  return entry.target !== undefined && targetCovers(entry.target, tool);
}

/**
 * The policy of a subagent's tool lists, in Claude Code's grammar: `disallowedTools` takes tools
 * away first (an entry with a specifier, such as `Bash(git push *)`, takes the whole tool), then
 * `tools`, when given, keeps only the tools an entry names. `Agent` (or `Task`) keeps the `agent`
 * tool and its companions `send_message`, `task_output` and `task_stop`. Undefined when the
 * subagent sets neither list
 */
export function toolPolicy(
  definition: Pick<SubagentDefinition, 'tools' | 'disallowedTools'>
): ToolPolicy | undefined {
  if (definition.tools === undefined && definition.disallowedTools === undefined) return undefined;
  const invalid: string[] = [];
  const allowed = definition.tools === undefined ? undefined : entriesOf(definition.tools, invalid);
  const denied = entriesOf(definition.disallowedTools, invalid);
  const named = (entries: readonly Entry[], tool: Tool): boolean => {
    if (entries.some((entry) => covers(entry, tool))) return true;
    if (!DELEGATION_COMPANIONS.has(tool.name)) return false;
    const agentTool: Tool = { ...tool, access: { kind: 'agent' } };
    return entries.some((entry) => covers(entry, agentTool));
  };
  const allows = (tool: Tool): boolean => {
    if (ALWAYS_KEPT.has(tool.name)) return true;
    if (named(denied, tool)) return false;
    return allowed === undefined || named(allowed, tool);
  };
  return {
    allows,
    invalid,
    unresolved: (pool) =>
      [...(allowed ?? []), ...denied]
        .filter((entry) => !pool.some((tool) => covers(entry, tool)))
        .map((entry) => entry.text),
    empty: (pool) =>
      allowed !== undefined && !pool.some((tool) => !ALWAYS_KEPT.has(tool.name) && allows(tool)),
  };
}
