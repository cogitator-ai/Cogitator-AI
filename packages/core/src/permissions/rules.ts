/**
 * The grammar of permission rules, compatible with Claude Code's `permissions` settings: a tool
 * name, or a tool name and a specifier in parentheses
 */

import type { PermissionBehavior, Tool } from '@cogitator-ai/types';
import { wildcardMatch } from './wildcard';
import { own } from '../utils/own';
import { companionOf } from '../subagents/marker';

/** A rule read from its text */
export interface ParsedRule {
  /** The rule as written */
  text: string;
  /** The tool name, or a glob of names (`*`, `mcp__*`, `mcp__github__get_*`) */
  tool: string;
  /** What is in the parentheses, absent for a bare tool name and for `Tool(*)` */
  specifier?: string;
}

/** What a rule's tool name stands for */
/** What a tool's calls touch, see `ToolAccess.kind` */
export type AccessKind = 'read' | 'edit' | 'command' | 'fetch' | 'search' | 'agent';

export type RuleTarget =
  | { kind: 'family'; family: AccessKind }
  | { kind: 'names'; names: readonly string[]; pathRulesNeverMatch?: boolean }
  | { kind: 'mcp'; server: string; tool?: string; toolGlob?: string }
  | { kind: 'glob'; glob: string }
  | { kind: 'name'; name: string }
  | { kind: 'companion'; name: 'SendMessage' | 'TaskOutput' | 'TaskStop' };

/**
 * Claude Code's tool names. `Read`, `Edit`, `Bash`, `WebFetch`, `WebSearch` and `Agent` name every
 * tool of their kind (`ToolAccess.kind`), so `Edit(src/**)` also covers `write_file`, as in Claude
 * Code. `MultiEdit` and `NotebookEdit` match no tool here
 */
const CLAUDE_NAMES: Record<string, RuleTarget> = {
  Bash: { kind: 'family', family: 'command' },
  Read: { kind: 'family', family: 'read' },
  Edit: { kind: 'family', family: 'edit' },
  WebFetch: { kind: 'family', family: 'fetch' },
  WebSearch: { kind: 'family', family: 'search' },
  Agent: { kind: 'family', family: 'agent' },
  Task: { kind: 'family', family: 'agent' },
  MultiEdit: { kind: 'names', names: [], pathRulesNeverMatch: true },
  Write: { kind: 'names', names: ['write_file', 'file_write'], pathRulesNeverMatch: true },
  Glob: { kind: 'names', names: ['glob'], pathRulesNeverMatch: true },
  Grep: { kind: 'names', names: ['grep'], pathRulesNeverMatch: true },
  LS: { kind: 'names', names: ['list_files', 'file_list'], pathRulesNeverMatch: true },
  NotebookEdit: { kind: 'names', names: [], pathRulesNeverMatch: true },
  ExitPlanMode: { kind: 'names', names: ['exit_plan_mode'] },
  Skill: { kind: 'names', names: ['use_skill', 'read_skill_file'] },
  TodoWrite: { kind: 'names', names: ['write_todos'] },
  SendMessage: { kind: 'companion', name: 'SendMessage' },
  TaskOutput: { kind: 'companion', name: 'TaskOutput' },
  TaskStop: { kind: 'companion', name: 'TaskStop' },
};

/** Claude Code tools Cogitator has no counterpart for: a rule naming one matches nothing */
const UNMAPPED_CLAUDE_NAMES = new Set([
  'NotebookRead',
  'BashOutput',
  'KillShell',
  'KillBash',
  'SlashCommand',
  'EndConversation',
  'AskUserQuestion',
  'PowerShell',
  'Cd',
]);

/** Whether `name` is a Claude Code tool name that matches nothing in Cogitator */
export function isUnmappedClaudeName(name: string): boolean {
  return UNMAPPED_CLAUDE_NAMES.has(name) || name === 'MultiEdit' || name === 'NotebookEdit';
}

/** The built-in tools of each family, for tools that declare no `access` */
const FAMILY_NAMES: Record<AccessKind, readonly string[]> = {
  read: ['read_file', 'list_files', 'glob', 'grep', 'file_read', 'file_list', 'file_exists'],
  edit: ['edit_file', 'write_file', 'file_write', 'file_delete'],
  command: ['run_command', 'exec'],
  fetch: ['http_request', 'web_scrape'],
  search: ['web_search'],
  agent: [],
};

/**
 * Reads `text` as a rule: `Tool` or `Tool(specifier)`, the specifier everything between the first
 * `(` and the last `)`, so parentheses in it need no escaping. `Tool(*)` and `Tool()` are the bare
 * name
 */
export function parseRule(text: string): ParsedRule | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { error: 'a rule cannot be empty' };
  const open = trimmed.indexOf('(');
  if (open === -1) {
    if (trimmed.includes(')')) return { error: `"${text}" has a ")" without "("` };
    if (/\s/.test(trimmed)) return { error: `"${text}" is not a tool name` };
    return { text: trimmed, tool: trimmed };
  }
  if (!trimmed.endsWith(')')) return { error: `"${text}" does not end with ")"` };
  const tool = trimmed.slice(0, open).trim();
  if (tool === '' || /\s/.test(tool)) return { error: `"${text}" does not start with a tool name` };
  const specifier = trimmed.slice(open + 1, -1).trim();
  return specifier === '' || specifier === '*'
    ? { text: trimmed, tool }
    : { text: trimmed, tool, specifier };
}

/** An MCP server or tool name as it appears in `mcp__<server>__<tool>` names */
export function mcpNamePart(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * What the tool name of a rule stands for. A glob of names counts in `deny` and `ask` rules only,
 * an `allow` glob must start with a literal `mcp__<server>__`
 */
export function ruleTarget(
  rule: ParsedRule,
  behavior: PermissionBehavior
): RuleTarget | { error: string } {
  const name = rule.tool;
  const known = own(CLAUDE_NAMES, name);
  if (known) return known;
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const split = rest.indexOf('__');
    const server = split === -1 ? rest : rest.slice(0, split);
    const tool = split === -1 ? undefined : rest.slice(split + 2);
    if (server.includes('*')) {
      if (behavior === 'allow') {
        return { error: `the allow rule "${rule.text}" must name its MCP server without "*"` };
      }
      return { kind: 'glob', glob: name };
    }
    if (tool === undefined || tool === '*') return { kind: 'mcp', server };
    if (tool.includes('*')) return { kind: 'mcp', server, toolGlob: tool };
    return { kind: 'mcp', server, tool };
  }
  if (name.includes('*')) {
    if (behavior === 'allow') {
      return { error: `the allow rule "${rule.text}" names tools with "*", which allows nothing` };
    }
    return { kind: 'glob', glob: name };
  }
  return { kind: 'name', name };
}

/** The kind of what `tool`'s calls touch: its `access`, else the kind of a workspace tool of its name */
export function accessKindOf(tool: Tool): AccessKind | undefined {
  if (tool.access) return tool.access.kind;
  if (tool.mcp) return undefined;
  for (const family of ['read', 'edit', 'command', 'fetch', 'search'] as const) {
    if (FAMILY_NAMES[family].includes(tool.name)) return family;
  }
  return undefined;
}

/** Whether the tool name of a rule covers `tool` */
export function targetCovers(target: RuleTarget, tool: Tool): boolean {
  switch (target.kind) {
    case 'family':
      return accessKindOf(tool) === target.family;
    case 'names':
      return tool.mcp === undefined && target.names.includes(tool.name);
    case 'name':
      return tool.name === target.name;
    case 'companion':
      return companionOf(tool) === target.name;
    case 'glob':
      return (
        wildcardMatch(tool.name, target.glob) ||
        (tool.mcp !== undefined && wildcardMatch(mcpName(tool), target.glob))
      );
    case 'mcp': {
      const origin = tool.mcp;
      const literal = `mcp__${target.server}__`;
      if (origin && origin.server !== '' && mcpNamePart(origin.server) === target.server) {
        if (target.tool !== undefined) return mcpNamePart(origin.tool) === target.tool;
        if (target.toolGlob) return wildcardMatch(mcpNamePart(origin.tool), target.toolGlob);
        return true;
      }
      if (!tool.name.startsWith(literal)) return false;
      const rest = tool.name.slice(literal.length);
      if (target.tool !== undefined) return rest === target.tool;
      if (target.toolGlob) return wildcardMatch(rest, target.toolGlob);
      return true;
    }
  }
}

function mcpName(tool: Tool): string {
  return tool.mcp
    ? `mcp__${mcpNamePart(tool.mcp.server)}__${mcpNamePart(tool.mcp.tool)}`
    : tool.name;
}

/** `name:value` of a parameter specifier, the name an identifier, spaces around `:` allowed */
function parameterForm(specifier: string): { name: string; value: string } | undefined {
  const colon = specifier.indexOf(':');
  if (colon === -1) return undefined;
  const name = specifier.slice(0, colon).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  return { name, value: specifier.slice(colon + 1) };
}

/** The fields of a call that carry what its rules match, which a `param:value` rule cannot name */
const PRIMARY_FIELDS = new Set([
  'command',
  'path',
  'file_path',
  'filePath',
  'url',
  'notebook_path',
]);

/** A `param:value` specifier, when `specifier` is one for `tool` */
export function parameterSpecifier(
  specifier: string,
  tool: Tool,
  schemaKeys: ReadonlySet<string>
): { name: string; value: string } | undefined {
  if (specifier.trimEnd().endsWith(':*') && accessKindOf(tool) === 'command') return undefined;
  const match = parameterForm(specifier);
  if (!match) return undefined;
  const { name, value } = match;
  if (PRIMARY_FIELDS.has(name)) return undefined;
  const kind = accessKindOf(tool);
  if (kind !== undefined && !schemaKeys.has(name)) return undefined;
  return { name, value: value.trim() };
}

/** Whether a call's value of a parameter matches the value of a `param:value` rule (`*` for any text) */
export function parameterMatches(value: unknown, pattern: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return false;
  }
  return wildcardMatch(String(value), pattern);
}
