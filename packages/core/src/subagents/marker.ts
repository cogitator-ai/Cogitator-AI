import type { Tool } from '@cogitator-ai/types';

/** The `agent` tools of subagent runtimes, which take Claude Code's `Agent` input as it is */
const dispatchers = new WeakSet<object>();

/** The `send_message`, `task_output` and `task_stop` tools of subagent runtimes, by Claude Code's name */
const companions = new WeakMap<object, 'SendMessage' | 'TaskOutput' | 'TaskStop'>();

/** Which tools an agent's runs keep, see {@link setToolFilter} */
const filters = new WeakMap<object, (tool: Tool) => boolean>();

/** Marks `tool` as an `agent` tool that delegates to the subagent its call names */
export function markDispatcher<T extends object>(tool: T): T {
  dispatchers.add(tool);
  return tool;
}

/** Whether `tool` is an `agent` tool of a subagent runtime */
export function isDispatcher(tool: Tool): boolean {
  return dispatchers.has(tool);
}

/** Marks `tool` as the subagent tool Claude Code names `name` */
export function markCompanion<T extends object>(
  tool: T,
  name: 'SendMessage' | 'TaskOutput' | 'TaskStop'
): T {
  companions.set(tool, name);
  return tool;
}

/** Claude Code's name of a subagent tool (`SendMessage`, `TaskOutput`, `TaskStop`), if `tool` is one */
export function companionOf(tool: Tool): 'SendMessage' | 'TaskOutput' | 'TaskStop' | undefined {
  return companions.get(tool);
}

/**
 * Keeps only the tools `keep` accepts in every run of `agent`, the runtime's and the harness's
 * tools included: the tool lists of a subagent and of the ones above it, or a command's
 * `disallowed-tools`
 */
export function setToolFilter(agent: object, keep: (tool: Tool) => boolean): void {
  filters.set(agent, keep);
}

/** The tool filter of `agent`, see {@link setToolFilter} */
export function toolFilterOf(agent: object): ((tool: Tool) => boolean) | undefined {
  return filters.get(agent);
}

/** Gives `to`, a copy of `from` a run made, the tool filter of `from` */
export function copyToolFilter(from: object, to: object): void {
  const keep = filters.get(from);
  if (keep) filters.set(to, keep);
}
