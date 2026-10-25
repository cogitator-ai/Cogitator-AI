/**
 * Claude Code's tool names and input shapes for Cogitator's built-in tools, so a hook written for
 * Claude Code reads `tool_input.file_path` or `tool_input.command` as it expects
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { Tool } from '@cogitator-ai/types';
import { accessKindOf, mcpNamePart } from '../permissions/rules';

/** How one tool looks to a Claude Code hook */
export interface ClaudeTool {
  /** Claude Code's name of the tool, such as `Bash` */
  name: string;
  /** The call's arguments in Claude Code's shape */
  input(args: Record<string, unknown>, root: string): Record<string, unknown>;
  /** Arguments in Claude Code's shape back as the tool takes them, over the arguments it had */
  args(
    input: Record<string, unknown>,
    original: Record<string, unknown>,
    root: string
  ): Record<string, unknown>;
}

type Field = readonly [ours: string, theirs: string];

/** A tool whose fields only change names, `path` becoming an absolute `file_path` when `filePath` is set */
function renamed(name: string, fields: readonly Field[], filePath = false): ClaudeTool {
  return {
    name,
    input(args, root) {
      const input: Record<string, unknown> = {};
      for (const [ours, theirs] of fields) {
        if (args[ours] !== undefined) input[theirs] = args[ours];
      }
      if (filePath && typeof args.path === 'string') {
        input.file_path = isAbsolute(args.path) ? args.path : resolve(root, args.path);
      }
      return input;
    },
    args(input, original, root) {
      const args: Record<string, unknown> = { ...original };
      for (const [ours, theirs] of fields) {
        if (Object.hasOwn(input, theirs)) args[ours] = input[theirs];
      }
      if (filePath && typeof input.file_path === 'string') {
        const inside = relative(root, input.file_path);
        args.path =
          isAbsolute(input.file_path) && !inside.startsWith('..') && !isAbsolute(inside)
            ? inside || '.'
            : input.file_path;
      }
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
    true
  ),
  file_read: renamed('Read', [], true),
  write_file: renamed('Write', [['content', 'content']], true),
  file_write: renamed('Write', [['content', 'content']], true),
  edit_file: renamed(
    'Edit',
    [
      ['oldString', 'old_string'],
      ['newString', 'new_string'],
      ['replaceAll', 'replace_all'],
    ],
    true
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
