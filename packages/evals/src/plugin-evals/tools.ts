import { globMatches } from './glob';

/** Claude Code's name of each Cogitator tool an eval run can have */
const CLAUDE_NAME_OF: Readonly<Record<string, string>> = {
  read_file: 'Read',
  list_files: 'LS',
  glob: 'Glob',
  grep: 'Grep',
  write_file: 'Write',
  edit_file: 'Edit',
  run_command: 'Bash',
  use_skill: 'Skill',
  read_skill_file: 'Skill',
  write_todos: 'TodoWrite',
  agent: 'Agent',
  send_message: 'SendMessage',
  task_output: 'TaskOutput',
  task_stop: 'TaskStop',
  http_request: 'WebFetch',
  web_search: 'WebSearch',
};

/** The Cogitator tools a Claude Code tool name stands for */
const TOOLS_OF: Readonly<Record<string, readonly string[]>> = {
  Read: ['read_file', 'list_files'],
  LS: ['list_files'],
  Glob: ['glob'],
  Grep: ['grep'],
  Write: ['write_file'],
  Edit: ['edit_file'],
  Bash: ['run_command'],
  Skill: ['use_skill', 'read_skill_file'],
  TodoWrite: ['write_todos'],
  Agent: ['agent'],
  Task: ['agent'],
  SendMessage: ['send_message'],
  TaskOutput: ['task_output'],
  TaskStop: ['task_stop'],
  WebFetch: ['http_request'],
  WebSearch: ['web_search'],
};

/** The tools a case's `allowed_tools` grants by itself, any other needs a grant of the run */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'Skill',
  'AskUserQuestion',
  'Agent',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'TaskStop',
]);

/** Claude Code tools an eval run has no Cogitator counterpart for */
const NO_COUNTERPART: ReadonlySet<string> = new Set([
  'NotebookRead',
  'NotebookEdit',
  'MultiEdit',
  'AskUserQuestion',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'PowerShell',
  'BashOutput',
  'KillShell',
  'SlashCommand',
]);

/** The workspace tools an eval run can give, in the order the agent gets them */
export const WORKSPACE_TOOLS = [
  'read_file',
  'list_files',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'run_command',
] as const;

export type WorkspaceTool = (typeof WORKSPACE_TOOLS)[number];

/** A tool grant: a permission rule such as `Write` or `Bash(npm test *)` */
export interface ToolGrant {
  rule: string;
  tool: string;
  specifier?: string;
}

/** A grant read from its rule text, or why the text is not a rule */
export function parseGrant(rule: string): ToolGrant | { error: string } {
  const text = rule.trim();
  const match = /^([^()\s]+)(?:\((.*)\))?$/s.exec(text);
  if (!match) return { error: `"${rule}" is not a tool name or a rule such as Bash(npm test *)` };
  const [, tool = '', specifier] = match;
  const trimmed = specifier?.trim();
  return trimmed === undefined || trimmed === '' || trimmed === '*'
    ? { rule: text, tool }
    : { rule: text, tool, specifier: trimmed };
}

/** Claude Code's name of a Cogitator tool, the tool's own name when it has no counterpart */
export function claudeNameOf(tool: string): string {
  return CLAUDE_NAME_OF[tool] ?? tool;
}

/** Whether a grant of `grantTool` covers the tool named `tool` */
export function grantCovers(grantTool: string, tool: string): boolean {
  if (TOOLS_OF[grantTool]?.includes(tool)) return true;
  if (grantTool === tool) return true;
  return grantTool.includes('*') && globMatches(grantTool, tool);
}

/** Whether `name` (a grader's `tool`) names the call, by Claude Code's name or Cogitator's own */
export function namesCall(name: string, call: { name: string; tool: string }): boolean {
  if (name === call.name || name === call.tool) return true;
  return name === 'Task' && call.name === 'Agent';
}

/** The tools a case may use, and what it asked for that the run does not give */
export interface CaseGrants {
  grants: ToolGrant[];
  /** Tools the case lists that are neither read-only nor granted for the run */
  notGranted: string[];
  /** Granted Claude Code tools that have no Cogitator counterpart in an eval run */
  noCounterpart: string[];
}

/**
 * What a case may use: the read-only tools its `allowed_tools` lists, and every grant of the run.
 * A rule that cannot be read is an error
 */
export function caseGrants(
  allowedTools: readonly string[],
  runGrants: readonly ToolGrant[]
): CaseGrants | { error: string } {
  const grants: ToolGrant[] = [...runGrants];
  const notGranted: string[] = [];
  for (const entry of allowedTools) {
    const grant = parseGrant(entry);
    if ('error' in grant) return { error: `allowed_tools: ${grant.error}` };
    if (READ_ONLY_TOOLS.has(grant.tool)) grants.push(grant);
    else if (
      !runGrants.some((given) => grantCovers(given.tool, grant.tool) || given.rule === grant.rule)
    ) {
      notGranted.push(grant.rule);
    }
  }
  const noCounterpart = [
    ...new Set(grants.filter((grant) => NO_COUNTERPART.has(grant.tool)).map((g) => g.tool)),
  ];
  return { grants, notGranted, noCounterpart };
}

/** Whether any grant covers the tool named `tool` */
export function isGranted(grants: readonly ToolGrant[], tool: string): boolean {
  return grants.some((grant) => grantCovers(grant.tool, tool));
}
