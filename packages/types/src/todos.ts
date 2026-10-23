/**
 * The todo list an agent keeps with the built-in `write_todos` tool (`AgentConfig.todos`)
 */

/** Where an item of the todo list stands */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** An item of an agent's todo list */
export interface TodoItem {
  /** Names the item across updates of the list */
  readonly id: string;
  /** What is to be done */
  readonly content: string;
  readonly status: TodoStatus;
}
