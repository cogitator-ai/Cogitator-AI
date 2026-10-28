import { isAbsolute, resolve } from 'node:path';
import type { ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk';
import type { Tool, ToolPresentation, Workspace } from '@cogitator-ai/types';

/** How an editor shows a tool call: a title, a kind for its icon and the files it touches */
export interface ToolCallView {
  title: string;
  kind: ToolKind;
  locations: ToolCallLocation[];
}

/** The most characters of a tool's result an editor is sent as text */
export const MAX_RESULT_TEXT = 8000;

const KIND_BY_NAME: Readonly<Record<string, ToolKind>> = {
  read_file: 'read',
  file_read: 'read',
  read_skill_file: 'read',
  use_skill: 'read',
  list_files: 'search',
  glob: 'search',
  grep: 'search',
  tool_search: 'search',
  web_search: 'search',
  write_file: 'edit',
  edit_file: 'edit',
  file_write: 'edit',
  delete_file: 'delete',
  run_command: 'execute',
  exec: 'execute',
  web_fetch: 'fetch',
  write_todos: 'think',
  exit_plan_mode: 'switch_mode',
};

const KIND_BY_ACCESS: Readonly<Record<NonNullable<Tool['access']>['kind'], ToolKind>> = {
  read: 'read',
  edit: 'edit',
  command: 'execute',
  fetch: 'fetch',
  search: 'search',
  agent: 'other',
};

function presentationOf(
  tool: Tool | undefined,
  args: Record<string, unknown>
): ToolPresentation | undefined {
  const presentation = tool?.presentation;
  if (!presentation) return undefined;
  if (typeof presentation !== 'function') return presentation;
  try {
    return presentation(args);
  } catch {
    return undefined;
  }
}

function pathsOf(tool: Tool | undefined, args: Record<string, unknown>): readonly string[] {
  const access = tool?.access;
  if (!access?.paths || (access.kind !== 'read' && access.kind !== 'edit')) return [];
  try {
    return access.paths(args);
  } catch {
    return [];
  }
}

function commandOf(tool: Tool | undefined, args: Record<string, unknown>): string | undefined {
  if (tool?.access?.kind === 'command' && tool.access.command) {
    try {
      return tool.access.command(args);
    } catch {
      return undefined;
    }
  }
  return typeof args.command === 'string' ? args.command : undefined;
}

/** The kind of a call of tool `name`: by the name of a known tool, else by what it touches */
export function kindOf(name: string, tool?: Tool): ToolKind {
  return KIND_BY_NAME[name] ?? (tool?.access ? KIND_BY_ACCESS[tool.access.kind] : 'other');
}

/**
 * How an editor shows a call of tool `name` with `args`: its presentation as the title (the
 * command line for a command), the kind of the tool, and the absolute paths it reads or edits
 */
export function viewOfToolCall(
  name: string,
  args: Record<string, unknown>,
  tool: Tool | undefined,
  root: string
): ToolCallView {
  const kind = kindOf(name, tool);
  const command = kind === 'execute' ? commandOf(tool, args) : undefined;
  const presentation = presentationOf(tool, args);
  const title =
    command !== undefined
      ? `\`${command}\``
      : presentation
        ? presentation.detail
          ? `${presentation.label}: ${presentation.detail}`
          : presentation.label
        : name;
  const locations = pathsOf(tool, args).map((path) => ({
    path: isAbsolute(path) ? path : resolve(root, path),
  }));
  return { title, kind, locations };
}

/**
 * The change a `write_file` or `edit_file` call makes, as a diff an editor shows next to the
 * question or the result: the file's text now (none for a new file) and after the call.
 * Undefined for any other call, or an edit that would not apply
 */
export async function diffOfToolCall(
  name: string,
  args: Record<string, unknown>,
  workspace: Workspace | undefined
): Promise<ToolCallContent | undefined> {
  if (!workspace || typeof args.path !== 'string') return undefined;
  const path = isAbsolute(args.path) ? args.path : resolve(workspace.root, args.path);
  const current = async (): Promise<string | undefined> => {
    try {
      return await workspace.read(args.path as string);
    } catch {
      return undefined;
    }
  };
  if (name === 'write_file' && typeof args.content === 'string') {
    const oldText = await current();
    return {
      type: 'diff',
      path,
      newText: args.content,
      ...(oldText !== undefined && { oldText }),
    };
  }
  if (
    name === 'edit_file' &&
    typeof args.oldString === 'string' &&
    typeof args.newString === 'string' &&
    args.oldString !== ''
  ) {
    const oldText = await current();
    if (!oldText?.includes(args.oldString)) return undefined;
    const replacement = args.newString;
    const newText =
      args.replaceAll === true
        ? oldText.split(args.oldString).join(replacement)
        : oldText.replace(args.oldString, () => replacement);
    return { type: 'diff', path, oldText, newText };
  }
  return undefined;
}

function clip(text: string): string {
  return text.length <= MAX_RESULT_TEXT
    ? text
    : `${text.slice(0, MAX_RESULT_TEXT)}\n... (${text.length - MAX_RESULT_TEXT} more characters)`;
}

function textOf(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'stdout' in result && 'exitCode' in result) {
    const run = result as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
    return [run.stdout, run.stderr, `exit code ${String(run.exitCode)}`]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join('\n');
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** What a tool returned, or why it failed, as the content of its call in an editor */
export function resultContent(result: unknown, error?: string): ToolCallContent[] {
  const text = clip(error !== undefined ? `Error: ${error}` : textOf(result));
  return text === '' ? [] : [{ type: 'content', content: { type: 'text', text } }];
}
