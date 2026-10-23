import { describe, expect, it } from 'vitest';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Message, RunObserver, TodoItem, ToolCall } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { keepThroughCompaction } from '../cogitator/harness';
import { renderTodos, todoListSchema, todosIn } from '../tools/write-todos';
import { clearToolOutputsMiddleware } from '../middleware/clear-tool-outputs';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

const plan: TodoItem[] = [
  { id: 'read', content: 'Read the spec', status: 'in_progress' },
  { id: 'build', content: 'Build the parser', status: 'pending' },
];

const progressed: TodoItem[] = [
  { id: 'read', content: 'Read the spec', status: 'completed' },
  { id: 'build', content: 'Build the parser', status: 'in_progress' },
  { id: 'test', content: 'Test it', status: 'pending' },
];

function planner(): Agent {
  return new Agent({ name: 'planner', model: 'mock/m', instructions: 'Plan.', todos: true });
}

describe('todo list validation', () => {
  it('accepts a list with at most one item in progress', () => {
    expect(todoListSchema.safeParse(plan).success).toBe(true);
    expect(todoListSchema.safeParse([]).success).toBe(true);
  });

  it('refuses two items in progress, repeated ids and unknown statuses', () => {
    const two = todoListSchema.safeParse([
      { id: 'a', content: 'A', status: 'in_progress' },
      { id: 'b', content: 'B', status: 'in_progress' },
    ]);
    expect(two.success).toBe(false);
    expect(two.error?.issues[0]?.message).toBe('At most one item may be in_progress, 2 are: a, b');
    expect(
      todoListSchema.safeParse([
        { id: 'a', content: 'A', status: 'pending' },
        { id: 'a', content: 'B', status: 'pending' },
      ]).success
    ).toBe(false);
    expect(todoListSchema.safeParse([{ id: 'a', content: 'A', status: 'done' }]).success).toBe(
      false
    );
  });

  it('renders the list for the model', () => {
    expect(renderTodos(progressed)).toBe(
      'Todo list (1 of 3 completed):\n[x] read: Read the spec\n[>] build: Build the parser\n[ ] test: Test it'
    );
    expect(renderTodos([])).toBe('Todo list: empty.');
  });
});

describe('write_todos in a run', () => {
  it('replaces the list with each call, reports it and returns it as RunResult.todos', async () => {
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('t1', 'write_todos', { todos: plan })] },
      { toolCalls: [call('t2', 'write_todos', { todos: progressed })] },
      { content: 'Working on it.' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const reported: (readonly TodoItem[])[] = [];
    const observed: string[] = [];
    const observer: RunObserver = {
      onTodos: (todos, run) => observed.push(`${run.runId}:${todos.length}`),
    };
    cog.observe(observer);

    const result = await cog.run(planner(), {
      input: 'Build it',
      onTodos: (t) => reported.push(t),
    });

    expect(reported).toEqual([plan, progressed]);
    expect(observed).toEqual([`${result.runId}:2`, `${result.runId}:3`]);
    expect(result.todos).toEqual(progressed);
    const answer = result.messages.find((m) => m.toolCallId === 't2');
    expect(answer?.content).toBe(renderTodos(progressed));
    expect(backend.getCalls()[0]?.tools?.map((t) => t.name)).toEqual(['write_todos']);
    await cog.close();
  });

  it('answers an invalid list with a validation error and keeps the last valid one', async () => {
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('t1', 'write_todos', { todos: plan })] },
      {
        toolCalls: [
          call('t2', 'write_todos', {
            todos: [
              { id: 'a', content: 'A', status: 'in_progress' },
              { id: 'b', content: 'B', status: 'in_progress' },
            ],
          }),
        ],
      },
      { content: 'Ok.' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const errors: (string | undefined)[] = [];
    const result = await cog.run(planner(), {
      input: 'go',
      onToolResult: (r) => errors.push(r.error),
    });
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toContain('At most one item may be in_progress');
    expect(result.todos).toEqual(plan);
    expect(todosIn(result.messages)).toEqual(plan);
    await cog.close();
  });

  it('keeps the list in the thread metadata and shows it to a later run whose history lost it', async () => {
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('t1', 'write_todos', { todos: progressed })] },
      { content: 'Planned.' },
      { content: 'Continuing.' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      memory: { adapter: 'memory' },
    });
    await cog.run(planner(), { input: 'Plan it', threadId: 'thread_todos' });

    const memory = (await cog.getMemory())!;
    const thread = await memory.getThread('thread_todos');
    expect(thread.success && thread.data?.metadata.todos).toEqual(progressed);

    const later = await cog.run(planner(), {
      input: 'Go on',
      threadId: 'thread_todos',
      loadHistory: false,
    });
    expect(later.todos).toEqual(progressed);
    const sent = backend.getLastCall()!.messages;
    expect(sent.at(-2)).toEqual({
      role: 'system',
      content: `Your todo list from earlier in this conversation (update it with write_todos):\n${renderTodos(progressed)}`,
    });
    expect(sent.at(-1)).toMatchObject({ role: 'user', content: 'Go on' });
    await cog.close();
  });

  it('adds no write_todos without todos: true', async () => {
    const backend = new MockLLMBackend().setResponse({ content: 'Hi.' });
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const result = await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), {
      input: 'hi',
    });
    expect(backend.getLastCall()?.tools ?? []).toEqual([]);
    expect(result.todos).toBeUndefined();
    await cog.close();
  });
});

describe('the todo list through clearing and compaction', () => {
  const written: Message[] = [
    { role: 'system', content: 'Plan.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [call('t1', 'write_todos', { todos: plan })],
    } as Message,
    { role: 'tool', content: renderTodos(plan), toolCallId: 't1', name: 'write_todos' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [call('t2', 'write_todos', { todos: progressed })],
    } as Message,
    { role: 'tool', content: renderTodos(progressed), toolCallId: 't2', name: 'write_todos' },
    { role: 'user', content: 'next' },
  ];

  it('never clears a write_todos result', async () => {
    const middleware = clearToolOutputsMiddleware({ trigger: 0, keep: 0 });
    const update = await middleware.beforeModel!(
      { messages: written, model: 'mock/m' },
      {
        runId: 'r',
        agentId: 'a',
        agentName: 'a',
        iteration: 1,
        signal: new AbortController().signal,
        state: new Map(),
      }
    );
    expect(update).toBeUndefined();
  });

  it('shows the newest list again when a compaction dropped it', () => {
    const compacted: Message[] = [
      { role: 'system', content: 'Plan.' },
      { role: 'user', content: 'next' },
    ];
    const kept = keepThroughCompaction(written, compacted);
    expect(kept).toEqual([
      { role: 'system', content: 'Plan.' },
      {
        role: 'system',
        content: `Your todo list from earlier in this conversation (update it with write_todos):\n${renderTodos(progressed)}`,
      },
      { role: 'user', content: 'next' },
    ]);
    expect(keepThroughCompaction(kept, kept)).toEqual(kept);
    expect(keepThroughCompaction(written, written.slice(3))).toEqual(written.slice(3));
  });
});
