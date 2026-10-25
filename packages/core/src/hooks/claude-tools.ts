/**
 * Claude Code's tool names and input shapes for Cogitator's built-in tools, so a hook written for
 * Claude Code reads `tool_input.file_path` or `tool_input.command` as it expects
 */

import { isAbsolute, resolve } from 'node:path';
import type { Tool } from '@cogitator-ai/types';
import { accessKindOf, mcpNamePart } from '../permissions/rules';

/** How one tool looks to a Claude Code hook */
export interface ClaudeTool {
  /** Claude Code's name of the tool, such as `Bash` */
  name: string;
  /** The call's arguments in Claude Code's shape */
  input(args: Record<string, unknown>, root: string): Record<string, unknown>;
  /** Arguments in Claude Code's shape back as the tool takes them, over the arguments it had */
  args(input: Record<string, unknown>, original: Record<string, unknown>): Record<string, unknown>;
}

type Field = readonly [ours: string, theirs: string];

/**
 * Where a tool's relative `path` starts: the workspace root for the workspace tools, the working
 * directory of the process for the host file tools (`file_read`, `file_write`)
 */
type PathBase = 'workspace' | 'process';

/**
 * A tool whose fields only change names, its `path` given as an absolute `file_path` resolved
 * against the base the tool itself uses. A `file_path` coming back is kept as it is: an absolute
 * path stays absolute, so the tool reaches the file the hook named
 */
function renamed(name: string, fields: readonly Field[], filePath?: PathBase): ClaudeTool {
  return {
    name,
    input(args, root) {
      const input: Record<string, unknown> = {};
      for (const [ours, theirs] of fields) {
        if (args[ours] !== undefined) input[theirs] = args[ours];
      }
      if (filePath && typeof args.path === 'string') {
        const base = filePath === 'workspace' ? root : process.cwd();
        input.file_path = isAbsolute(args.path) ? args.path : resolve(base, args.path);
      }
      return input;
    },
    args(input, original) {
      const args: Record<string, unknown> = { ...original };
      for (const [ours, theirs] of fields) {
        if (Object.hasOwn(input, theirs)) args[ours] = input[theirs];
      }
      if (filePath && typeof input.file_path === 'string') args.path = input.file_path;
      return args;
    },
  };
}

const BASH = renamed('Bash', [
  ['command', 'command'],
  ['timeout', 'timeout'],
  ['background', 'run_in_background'],
]);

const BY_NAME: Record<string, ClaudeTool> = {
  run_command: BASH,
  exec: BASH,
  read_file: renamed(
    'Read',
    [
      ['offset', 'offset'],
      ['limit', 'limit'],
    ],
    'workspace'
  ),
  file_read: renamed('Read', [], 'process'),
  write_file: renamed('Write', [['content', 'content']], 'workspace'),
  file_write: renamed('Write', [['content', 'content']], 'process'),
  edit_file: renamed(
    'Edit',
    [
      ['oldString', 'old_string'],
      ['newString', 'new_string'],
      ['replaceAll', 'replace_all'],
    ],
    'workspace'
  ),
  glob: renamed('Glob', [
    ['pattern', 'pattern'],
    ['path', 'path'],
  ]),
  grep: renamed('Grep', [
    ['pattern', 'pattern'],
    ['path', 'path'],
    ['glob', 'glob'],
    ['ignoreCase', '-i'],
  ]),
  list_files: renamed('LS', [['path', 'path']]),
  file_list: renamed('LS', [['path', 'path']]),
  http_request: renamed('WebFetch', [['url', 'url']]),
  web_scrape: renamed('WebFetch', [['url', 'url']]),
  web_search: renamed('WebSearch', [['query', 'query']]),
  exit_plan_mode: renamed('ExitPlanMode', [['plan', 'plan']]),
  use_skill: renamed('Skill', [['skill', 'skill']]),
  write_todos: renamed('TodoWrite', [['todos', 'todos']]),
};

/** Claude Code's counterpart of `tool`, when it has one: a built-in tool, or an agent used as a tool */
export function claudeToolOf(tool: Tool): ClaudeTool | undefined {
  if (tool.mcp) return undefined;
  if (Object.hasOwn(BY_NAME, tool.name)) return BY_NAME[tool.name];
  if (accessKindOf(tool) === 'agent') return renamed('Agent', [['task', 'prompt']]);
  return undefined;
}

/** The names of `tool` itself: its own and its MCP name (`mcp__<server>__<tool>`) */
export function ownNamesOf(tool: Tool): string[] {
  const names = [tool.name];
  if (tool.mcp) names.push(`mcp__${mcpNamePart(tool.mcp.server)}__${mcpNamePart(tool.mcp.tool)}`);
  return names;
}
