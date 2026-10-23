import { z } from 'zod';
import type { Message, TodoItem, Tool, ToolCall, ToolContentResult } from '@cogitator-ai/types';
import { tool } from '../tool';
import { toolContent } from '../tool-content';
import { getTextContent } from '../cogitator/span-factory';

/** Name of the built-in tool that writes the agent's todo list */
export const WRITE_TODOS = 'write_todos';

/** The key of a thread's metadata the todo list is kept under */
export const TODOS_METADATA_KEY = 'todos';

/** Most items a todo list holds */
export const MAX_TODOS = 100;

const STATUS_MARKS: Record<TodoItem['status'], string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
};

const todoItemSchema = z.object({
  id: z.string().min(1).max(200).describe('Short id that names the item across updates'),
  content: z.string().min(1).max(2000).describe('What is to be done'),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

/** A todo list: unique ids and at most one item in progress. */
export const todoListSchema = z
  .array(todoItemSchema)
  .max(MAX_TODOS)
  .superRefine((todos, context) => {
    const seen = new Set<string>();
    for (const todo of todos) {
      if (seen.has(todo.id)) {
        context.addIssue({ code: 'custom', message: `The id "${todo.id}" is used twice` });
      }
      seen.add(todo.id);
    }
    const working = todos.filter((todo) => todo.status === 'in_progress');
    if (working.length > 1) {
      context.addIssue({
        code: 'custom',
        message: `At most one item may be in_progress, ${working.length} are: ${working.map((todo) => todo.id).join(', ')}`,
      });
    }
  });

/** `value` as a todo list, when it is one (a list kept in thread metadata, say). */
export function parseTodos(value: unknown): TodoItem[] | undefined {
  const parsed = todoListSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The todo list as the model reads it: a line per item with its status mark and id. */
export function renderTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return 'Todo list: empty.';
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return [
    `Todo list (${done} of ${todos.length} completed):`,
    ...todos.map((todo) => `${STATUS_MARKS[todo.status]} ${todo.id}: ${todo.content}`),
  ].join('\n');
}

/**
 * The `write_todos` tool: the model writes its whole todo list with each call, and `onChange`
 * gets the new list before the model reads it back.
 */
export function writeTodosTool(
  onChange: (todos: TodoItem[]) => void | Promise<void>
): Tool<{ todos: TodoItem[] }, ToolContentResult> {
  return tool({
    name: WRITE_TODOS,
    description:
      'Plan and track a task of several steps as a todo list. Each call replaces the whole list: send every item with its current status. Keep the item you work on in_progress (at most one), mark items completed as soon as they are done, and add steps you discover. Not needed for a task of one or two steps.',
    parameters: z.object({ todos: todoListSchema.describe('The whole todo list') }),
    execute: async ({ todos }) => {
      await onChange(todos);
      return toolContent({ type: 'text', text: renderTodos(todos) });
    },
  });
}

/**
 * The todo list `messages` last wrote: the arguments of the newest `write_todos` call that
 * succeeded, or undefined when they hold none.
 */
export function todosIn(messages: readonly Message[]): TodoItem[] | undefined {
  const calls = new Map<string, ToolCall>();
  let latest: TodoItem[] | undefined;
  for (const message of messages) {
    if (message.role === 'assistant' && 'toolCalls' in message) {
      const toolCalls: unknown = message.toolCalls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls as ToolCall[]) {
          if (call.name === WRITE_TODOS) calls.set(call.id, call);
        }
      }
      continue;
    }
    if (message.role !== 'tool' || message.toolCallId === undefined) continue;
    const call = calls.get(message.toolCallId);
    if (!call || isErrorResult(getTextContent(message.content))) continue;
    const todos = parseTodos(call.arguments.todos);
    if (todos) latest = todos;
  }
  return latest;
}

/** Whether a tool message's text is the error a failed call answers with. */
function isErrorResult(text: string): boolean {
  if (!text.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && 'error' in parsed;
  } catch {
    return false;
  }
}
