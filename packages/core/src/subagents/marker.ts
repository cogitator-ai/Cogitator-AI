import type { Tool } from '@cogitator-ai/types';

/** The `agent` tools of subagent runtimes, which take Claude Code's `Agent` input as it is */
const dispatchers = new WeakSet<object>();

/** Marks `tool` as an `agent` tool that delegates to the subagent its call names */
export function markDispatcher<T extends object>(tool: T): T {
  dispatchers.add(tool);
  return tool;
}

/** Whether `tool` is an `agent` tool of a subagent runtime */
export function isDispatcher(tool: Tool): boolean {
  return dispatchers.has(tool);
}
