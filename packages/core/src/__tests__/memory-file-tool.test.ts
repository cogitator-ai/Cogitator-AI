import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import { InMemoryAdapter, MemoryFiles } from '@cogitator-ai/memory';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { memoryFileCommand, memoryFileTool } from '../tools/memory-file-tool';
import { createToolContext } from './helpers/tool-context';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A model that makes the given calls, one turn each, then answers with the last tool output */
function calling(calls: Record<string, unknown>[]): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let turn = 0;
  return {
    requests,
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      const call = calls[turn++];
      if (call) {
        const toolCall: ToolCall = { id: `c${turn}`, name: 'memory', arguments: call };
        return { id: 'r', content: '', toolCalls: [toolCall], finishReason: 'tool_calls', usage };
      }
      turn = 0;
      calls.length = 0;
      const last = [...request.messages].reverse().find((message) => message.role === 'tool');
      return { id: 'r', content: String(last?.content ?? 'none'), finishReason: 'stop', usage };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const lastUserText = (request: ChatRequest | undefined) =>
  String([...(request?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');

describe('memory tool in a run', () => {
  const cogs: Cogitator[] = [];
  afterEach(async () => {
    for (const cog of cogs.splice(0)) await cog.close();
  });

  function runtime(llm: LLMBackend, files: object = {}) {
    const cog = new Cogitator({
      llm: { backends: { mock: llm } },
      memory: { adapter: 'memory', files },
    });
    cogs.push(cog);
    return cog;
  }

  const agent = new Agent({ name: 'notes', model: 'mock/m', instructions: 'x' });

  it("gives every agent the memory tool, keeps the user's files, and lists them for the next turn", async () => {
    const llm = calling([
      { command: 'create', path: '/memories/prefs.md', file_text: 'Ana likes window seats' },
      { command: 'view', path: '/memories/prefs.md' },
    ]);
    const cog = runtime(llm);

    const first = await cog.run(agent, { input: 'note it', userId: 'ana', threadId: 't1' });
    expect(first.output).toBe(
      "Here's the content of /memories/prefs.md with line numbers:\n     1\tAna likes window seats"
    );
    expect(llm.requests[0]?.tools?.find((t) => t.name === 'memory')?.providerTypes).toEqual({
      anthropic: 'memory_20250818',
    });

    await cog.run(agent, { input: 'what do you know?', userId: 'ana', threadId: 't2' });
    expect(lastUserText(llm.requests.at(-1))).toContain(
      '- /memories/prefs.md (22B): Ana likes window seats'
    );

    await cog.run(agent, { input: 'and about me?', userId: 'bo', threadId: 't3' });
    expect(lastUserText(llm.requests.at(-1))).not.toContain('prefs.md');
  });

  it('keeps a branch to the files it wrote', async () => {
    const llm = calling([]);
    const cog = runtime(llm);
    const root = await cog.run(agent, { input: 'start', userId: 'ana', threadId: 't' });
    const fork = root.memory?.leafId;
    if (!fork) throw new Error('no leaf');

    llm.requests.length = 0;
    const calls = calling([{ command: 'create', path: '/memories/a.md', file_text: 'on A' }]);
    llm.chat = calls.chat;
    const onA = await cog.run(agent, {
      input: 'write on A',
      userId: 'ana',
      threadId: 't',
      branch: { fromEntryId: fork, activate: false },
    });
    const leafA = onA.memory?.leafId;
    if (!leafA) throw new Error('no leaf on A');

    await cog.run(agent, {
      input: 'read on A',
      userId: 'ana',
      threadId: 't',
      branch: { fromEntryId: leafA, activate: false },
    });
    expect(lastUserText(calls.requests.at(-1))).toContain('/memories/a.md');

    await cog.run(agent, {
      input: 'read on B',
      userId: 'ana',
      threadId: 't',
      branch: { fromEntryId: fork, activate: false },
    });
    expect(lastUserText(calls.requests.at(-1))).not.toContain('/memories/a.md');
  });

  it("reads no thread's files for a run the runtime let into no thread", async () => {
    const llm = calling([{ command: 'view', path: '/memories/secret.md' }]);
    const cog = runtime(llm);
    const memory = await cog.getMemory();
    if (!memory) throw new Error('no memory');
    await memory.createThread('notes', { userId: 'ana' }, 'ana-thread');
    await new MemoryFiles({ adapter: memory as unknown as InMemoryAdapter }).create(
      { scope: { agentId: 'notes', threadId: 'ana-thread' } },
      '/memories/secret.md',
      'Ana only'
    );

    const result = await cog.run(agent, {
      input: 'show it',
      userId: 'bo',
      threadId: 'ana-thread',
      useMemory: false,
    });

    expect(result.output).not.toContain('Ana only');
  });

  it('refuses changes when the files are read-only', async () => {
    const llm = calling([{ command: 'create', path: '/memories/a.md', file_text: 'x' }]);
    const cog = runtime(llm, { readOnly: true });

    const result = await cog.run(agent, { input: 'note it', userId: 'ana' });

    expect(result.output).toContain('The memory at /memories/a.md is read-only');
  });
});

describe('memoryFileTool', () => {
  it('refuses an edit of a file changed since the run viewed it', async () => {
    const memory = new InMemoryAdapter({ provider: 'memory' });
    await memory.connect();
    const files = new MemoryFiles({ adapter: memory });
    const memoryTool = memoryFileTool({ memory, agentId: 'notes' });
    const context = createToolContext({ userId: 'ana', runId: 'run-1' });
    await memoryTool.execute(
      { command: 'create', path: '/memories/plan.md', file_text: 'step one' },
      context
    );
    await memoryTool.execute({ command: 'view', path: '/memories/plan.md' }, context);

    await files.strReplace(
      { scope: { agentId: 'notes', userId: 'ana' }, author: 'user' },
      '/memories/plan.md',
      'one',
      'two'
    );

    await expect(
      memoryTool.execute(
        { command: 'str_replace', path: '/memories/plan.md', old_str: 'two', new_str: 'three' },
        context
      )
    ).rejects.toThrow('changed since it was viewed');
    await memoryTool.execute({ command: 'view', path: '/memories/plan.md' }, context);
    const edited = await memoryTool.execute(
      { command: 'str_replace', path: '/memories/plan.md', old_str: 'two', new_str: 'three' },
      context
    );
    expect(edited.content).toEqual([
      {
        type: 'text',
        text: 'The memory file has been edited. Here is the snippet showing the change (with line numbers):\n     1\tstep three',
      },
    ]);
  });

  it('says which field a command is missing', () => {
    expect(() => memoryFileCommand({ command: 'create', path: '/memories/a.md' })).toThrow(
      'The create command needs `file_text`'
    );
    expect(() => memoryFileCommand({ command: 'rename', old_path: '/memories/a.md' })).toThrow(
      'The rename command needs `new_path`'
    );
  });

  it('is refused a store that keeps no memory files', () => {
    const store = new InMemoryAdapter({ provider: 'memory' });
    const plain = new Proxy(store, {
      get(target, property) {
        if (property === 'putFileVersions') return undefined;
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => memoryFileTool({ memory: plain, agentId: 'notes' })).toThrow(
      'keeps no memory files'
    );
  });
});
