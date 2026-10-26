import type { WorkspaceToolName } from '../tools/workspace-tools';

/** What a harness agent has, which decides what {@link harnessPrompt} tells the model */
export interface HarnessPromptFeatures {
  /** The workspace tools the agent has */
  workspaceTools: readonly WorkspaceToolName[];
  /** Whether a tool result too long for the model is saved to the workspace */
  offload?: boolean;
  /** Whether independent read-only calls of a turn run together */
  parallelToolCalls?: boolean;
  /** Whether the agent has `write_todos` */
  todos?: boolean;
  /** Whether the agent can hand tasks to subagents with the `agent` tool */
  subagents?: boolean;
  /** Whether some of the agent's tools wait for `tool_search` */
  toolSearch?: boolean;
  /** Whether calls may wait for approval or be refused by permission rules */
  permissions?: boolean;
}

/**
 * The part of a harness agent's system prompt that tells the model how to use what the harness
 * gave it: the workspace and its tools, the todo list, subagents, deferred tools and approvals.
 * Only what the agent has is mentioned, and nothing in it changes between runs (no paths, no
 * dates), so it stays in the provider's prompt cache. Empty when the agent has none of them.
 * Skills and project instructions are not described here: the runtime adds their own sections
 */
export function harnessPrompt(features: HarnessPromptFeatures): string {
  const has = (name: WorkspaceToolName) => features.workspaceTools.includes(name);
  const sections: string[] = [];

  const workspace: string[] = [];
  if (has('glob') || has('grep') || has('list_files')) {
    const finders = [
      has('glob') && 'find files by name with glob',
      has('grep') && 'search their contents with grep',
      has('list_files') && 'list a directory with list_files',
    ].filter((part): part is string => typeof part === 'string');
    workspace.push(`- ${capitalize(finders.join(', '))}, instead of guessing paths.`);
  }
  if (has('read_file') && (has('edit_file') || has('write_file'))) {
    const writers = [
      has('edit_file') && 'change part of a file with edit_file',
      has('write_file') && 'create a file or replace a whole one with write_file',
    ].filter((part): part is string => typeof part === 'string');
    workspace.push(
      `- Read a file with read_file before you change it, then ${writers.join(' and ')}.`
    );
  } else if (has('read_file')) {
    workspace.push('- Read files with read_file.');
  }
  if (has('run_command')) {
    workspace.push(
      "- Run commands (tests, builds, git) with run_command. Check your changes with the project's own tests or build when it has them."
    );
  }
  if (features.offload && has('read_file')) {
    workspace.push(
      '- A tool result too long to show whole is saved to a file of the workspace: you get its start and its path, read the rest with read_file when you need it.'
    );
  }
  if (features.parallelToolCalls && workspace.length > 0) {
    workspace.push(
      '- Make calls that do not depend on each other in one turn: the ones that only read run at the same time.'
    );
  }
  if (workspace.length > 0) {
    sections.push(
      [
        '## Workspace',
        'You work in a workspace: a directory your file tools reach. Paths are relative to its root, nothing outside it is reachable.',
        ...workspace,
      ].join('\n')
    );
  }

  if (features.todos) {
    sections.push(
      [
        '## Planning',
        'For a task of three steps or more, write a todo list with write_todos before you start and keep it current: one item in_progress at a time, each marked completed as soon as it is done. Skip it for a simple question.',
      ].join('\n')
    );
  }

  if (features.subagents) {
    sections.push(
      [
        '## Subagents',
        'The agent tool hands a self-contained task (a broad search, an investigation, a side task) to a subagent, which works in a context of its own and answers with a report. It sees nothing of this conversation, so give it everything it needs in the prompt. Do small tasks yourself.',
      ].join('\n')
    );
  }

  if (features.toolSearch) {
    sections.push(
      [
        '## More tools',
        'Some of your tools are not loaded yet. When none of the tools you see fits a step, look for one with tool_search, then call what it finds.',
      ].join('\n')
    );
  }

  if (features.permissions) {
    sections.push(
      [
        '## Approvals',
        'Some calls wait for the user to approve them, and rules may refuse others. When a call is declined or refused, do not make it again unchanged: take another way or ask the user.',
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
