import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RunMiddleware,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
  Workspace,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { tool } from '../tool';
import { getLogger } from '../logger';
import { LocalWorkspace } from '../workspace/local-workspace';
import { workspaceTools } from '../tools/workspace-tools';
import { toolResultPath } from '../cogitator/tool-executor';
import { agentAsTool } from '../agent-tool';
import { truncateToolResultText } from '../tool-content';

let base: string;
let agentWorkspace: LocalWorkspace;
let runWorkspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-run-')));
  agentWorkspace = new LocalWorkspace({ root: join(base, 'agent'), id: 'agent-ws' });
  runWorkspace = new LocalWorkspace({ root: join(base, 'run'), id: 'run-ws' });
  await Promise.all([agentWorkspace.start(), runWorkspace.start()]);
});

afterEach(async () => {
  await Promise.all([agentWorkspace.dispose(), runWorkspace.dispose()]);
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A model that makes `calls` one turn after another, then answers. */
function scriptedBackend(calls: ToolCall[]) {
  const requests: ChatRequest[] = [];
  const respond = (request: ChatRequest): ChatResponse => {
    requests.push(request);
    const turn = request.messages.filter((m) => m.role === 'tool').length;
    const next = calls[turn];
    return next
      ? {
          id: `r${turn}`,
          content: '',
          toolCalls: [next],
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
      : {
          id: 'done',
          content: 'Done.',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, requests };
}

const seen: (string | undefined)[] = [];
const whichWorkspace = tool({
  name: 'which_workspace',
  description: 'Say which workspace the call got',
  parameters: z.object({}),
  execute: async (_args, context) => {
    seen.push(context.workspace?.id);
    return { id: context.workspace?.id ?? null };
  },
});

const LONG = Array.from({ length: 400 }, (_, i) => `row ${i + 1}: ${'data '.repeat(4)}`).join('\n');
const dump = tool({
  name: 'dump',
  description: 'Return a long text',
  parameters: z.object({}),
  maxResultLength: 1000,
  execute: async () => LONG,
});

function toolMessages(requests: ChatRequest[]): string[] {
  const last = requests[requests.length - 1];
  return last.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
}

describe('run workspace', () => {
  it('gives tools the agent workspace, and the run workspace over it', async () => {
    seen.length = 0;
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [whichWorkspace],
      workspace: agentWorkspace,
    });
    const call: ToolCall = { id: 'c1', name: 'which_workspace', arguments: {} };

    const first = scriptedBackend([call]);
    await new Cogitator({ llm: { backends: { mock: first.backend } } }).run(agent, { input: 'go' });
    const second = scriptedBackend([call]);
    await new Cogitator({ llm: { backends: { mock: second.backend } } }).run(agent, {
      input: 'go',
      workspace: runWorkspace,
    });
    const third = scriptedBackend([call]);
    await new Cogitator({ llm: { backends: { mock: third.backend } } }).run(
      new Agent({ name: 'b', model: 'mock/m', instructions: 'x', tools: [whichWorkspace] }),
      { input: 'go' }
    );

    expect(seen).toEqual(['agent-ws', 'run-ws', undefined]);
  });

  it('gives invokeTool the workspace it is passed', async () => {
    const cog = new Cogitator();
    const result = await cog.invokeTool(whichWorkspace, {}, { workspace: runWorkspace });
    expect(result.result).toEqual({ id: 'run-ws' });
  });
});

describe('offload of long tool results', () => {
  it('saves the full result in the workspace and gives the model a preview and the path', async () => {
    const { backend, requests } = scriptedBackend([
      { id: 'call_1', name: 'dump', arguments: {} },
      {
        id: 'call_2',
        name: 'read_file',
        arguments: { path: 'PLACEHOLDER', offset: 200, limit: 2 },
      },
    ]);
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [dump, ...workspaceTools()],
      workspace: runWorkspace,
    });
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const original = backend.chat;
    backend.chat = vi.fn(async (request: ChatRequest) => {
      const response = await original(request);
      const read = response.toolCalls?.find((c) => c.name === 'read_file');
      const saved = /\.cogitator\/tool-results\/\S+\.txt/.exec(toolMessages([request]).join('\n'));
      if (read && saved) read.arguments.path = saved[0];
      return response;
    });

    const result = await cog.run(agent, { input: 'dump it' });

    const path = toolResultPath(result.runId, 'call_1');
    expect(path).toBe(`.cogitator/tool-results/${result.runId}/call_1.txt`);
    expect(await runWorkspace.read(path)).toBe(LONG);

    const [preview, page] = toolMessages(requests);
    const plainCut = truncateToolResultText(JSON.stringify(LONG), 1000);
    expect(preview.length).toBeLessThanOrEqual(plainCut.length + 5);
    expect(preview.startsWith(JSON.stringify(LONG).slice(0, 100))).toBe(true);
    expect(preview).toContain('characters of this tool result were left out');
    expect(preview).toContain(path);
    expect(preview).toContain('read_file');
    expect(JSON.parse(page)).toMatchObject({
      content: `row 200: ${'data '.repeat(4)}\nrow 201: ${'data '.repeat(4)}`,
      startLine: 200,
      totalLines: 400,
    });
  });

  it('only cuts the result without a workspace', async () => {
    const { backend, requests } = scriptedBackend([{ id: 'call_1', name: 'dump', arguments: {} }]);
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [dump] });
    await new Cogitator({ llm: { backends: { mock: backend } } }).run(agent, { input: 'dump' });

    const [message] = toolMessages(requests);
    expect(message).toContain('characters of this tool result were left out');
    expect(message).not.toContain('.cogitator/tool-results');
  });

  it('leaves short results alone', async () => {
    const { backend } = scriptedBackend([{ id: 'call_1', name: 'which_workspace', arguments: {} }]);
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [whichWorkspace],
      workspace: runWorkspace,
    });
    await new Cogitator({ llm: { backends: { mock: backend } } }).run(agent, { input: 'x' });
    expect(existsSync(join(runWorkspace.root, '.cogitator'))).toBe(false);
  });

  it('falls back to cutting the result, with a warning, when the workspace cannot save it', async () => {
    const broken: Workspace = Object.assign(Object.create(runWorkspace) as LocalWorkspace, {
      write: async (): Promise<void> => {
        throw new Error('disk full');
      },
    });
    const warn = vi.spyOn(getLogger(), 'warn');
    const { backend, requests } = scriptedBackend([{ id: 'call_1', name: 'dump', arguments: {} }]);
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [dump, ...workspaceTools(undefined, { tools: ['read_file'] })],
    });
    await new Cogitator({ llm: { backends: { mock: backend } } }).run(agent, {
      input: 'dump',
      workspace: broken,
    });

    const [message] = toolMessages(requests);
    expect(message).toContain('characters of this tool result were left out');
    expect(message).not.toContain('.cogitator/tool-results');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not save a long tool result'),
      expect.objectContaining({ tool: 'dump', error: 'disk full' })
    );
  });
});

describe('offload housekeeping', () => {
  const reader = () => workspaceTools(undefined, { tools: ['read_file'] });

  async function dumpOnce(options: { retention?: number; tools?: ReturnType<typeof reader> } = {}) {
    const { backend, requests } = scriptedBackend([
      { id: 'call/1:x', name: 'dump', arguments: {} },
    ]);
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [dump, ...(options.tools ?? reader())],
      workspace: runWorkspace,
    });
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      ...(options.retention !== undefined && {
        limits: { toolResultRetention: options.retention },
      }),
    });
    const result = await cog.run(agent, { input: 'dump' });
    return { result, message: toolMessages(requests)[0] };
  }

  it('keeps saved results out of git and names ids safely, with a hash when they change', async () => {
    const { result, message } = await dumpOnce();
    expect(await runWorkspace.read('.cogitator/.gitignore')).toBe('*\n');
    const path = toolResultPath(result.runId, 'call/1:x');
    expect(path).toMatch(/\/call_1_x-[0-9a-f]{8}\.txt$/);
    expect(toolResultPath(result.runId, 'call_1_x')).not.toBe(path);
    expect(message).toContain(path);
    expect(message).toContain('nextColumn');
    expect(await runWorkspace.read(path)).toBe(LONG);
  });

  it('removes the results of runs older than the retention', async () => {
    const first = await dumpOnce();
    const second = await dumpOnce({ retention: 0 });
    const runs = await runWorkspace.list('.cogitator/tool-results');
    expect(runs.map((r) => r.name)).toEqual([second.result.runId]);
    expect(first.result.runId).not.toBe(second.result.runId);
  });

  it('does not offload when the agent cannot read the saved file', async () => {
    const { message } = await dumpOnce({ tools: [] });
    expect(message).toContain('characters of this tool result were left out');
    expect(message).not.toContain('.cogitator/tool-results');
    expect(existsSync(join(runWorkspace.root, '.cogitator'))).toBe(false);
  });

  it('refuses a negative retention', () => {
    expect(() => new Cogitator({ limits: { toolResultRetention: -1 } })).toThrow(
      /toolResultRetention/
    );
  });
});

describe('workspace across agents and hooks', () => {
  it('follows the handoff target, unless the run set one', async () => {
    seen.length = 0;
    const billing = new Agent({
      name: 'billing',
      model: 'mock/m',
      instructions: 'You are billing.',
      tools: [whichWorkspace],
      workspace: runWorkspace,
    });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/m',
      instructions: 'You are triage.',
      handoffs: [billing],
      workspace: agentWorkspace,
    });
    const script = () => {
      const backend: LLMBackend = {
        provider: 'openai',
        chat: vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
          const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
          const system = String(request.messages[0].content);
          const asked = request.messages.some(
            (m) => m.role === 'tool' && m.name === 'which_workspace'
          );
          if (system.startsWith('You are triage.')) {
            return {
              id: 't',
              content: '',
              toolCalls: [{ id: 'h', name: 'transfer_to_billing', arguments: {} }],
              finishReason: 'tool_calls',
              usage,
            };
          }
          return asked
            ? { id: 'd', content: 'done', finishReason: 'stop', usage }
            : {
                id: 'b',
                content: '',
                toolCalls: [{ id: 'w', name: 'which_workspace', arguments: {} }],
                finishReason: 'tool_calls',
                usage,
              };
        }),
        chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
          yield { id: 's', delta: {}, finishReason: 'stop' };
        }),
      };
      return new Cogitator({ llm: { backends: { mock: backend } } });
    };

    await script().run(triage, { input: 'refund' });
    const own = new LocalWorkspace({ root: join(base, 'own'), id: 'own-ws' });
    await script().run(triage, { input: 'refund', workspace: own });
    await own.dispose();

    expect(seen).toEqual(['run-ws', 'own-ws']);
  });

  it('is passed again to resume(), like deps', async () => {
    seen.length = 0;
    const careful = tool({
      name: 'careful',
      description: 'Needs approval',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async (_args, context) => {
        seen.push(context.workspace?.id);
        return 'ok';
      },
    });
    const { backend } = scriptedBackend([{ id: 'c1', name: 'careful', arguments: {} }]);
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [careful] });

    const paused = await cog.run(agent, { input: 'go', workspace: runWorkspace });
    expect(paused.status).toBe('paused');
    await cog.resume(agent, paused.checkpoint!, {
      decisions: { c1: { approved: true } },
      workspace: runWorkspace,
    });
    expect(seen).toEqual(['run-ws']);
  });

  it('reaches an agent called as a tool, unless it has its own', async () => {
    seen.length = 0;
    const call: ToolCall = { id: 'c1', name: 'which_workspace', arguments: {} };
    const innerBackend = scriptedBackend([call]);
    const cog = new Cogitator({ llm: { backends: { mock: innerBackend.backend } } });
    const bare = new Agent({
      name: 'bare',
      model: 'mock/m',
      instructions: 'x',
      tools: [whichWorkspace],
    });
    const owning = bare.clone({ name: 'owning', workspace: agentWorkspace });

    for (const inner of [bare, owning]) {
      const asTool = agentAsTool(cog, inner, { name: `ask_${inner.name}`, description: 'ask' });
      await asTool.execute(
        { task: 'which workspace?' },
        {
          agentId: 'outer',
          runId: 'r',
          signal: new AbortController().signal,
          workspace: runWorkspace,
        }
      );
      innerBackend.backend.chat = scriptedBackend([call]).backend.chat;
    }
    expect(seen).toEqual(['run-ws', 'agent-ws']);
  });

  it('is in the middleware context of tool calls and of the run', async () => {
    const ids: (string | undefined)[] = [];
    const watcher: RunMiddleware = {
      name: 'watcher',
      beforeRun: (_event, context) => {
        ids.push(context.workspace?.id);
      },
      wrapToolCall: async (call, next, context) => {
        ids.push(context.workspace?.id);
        return next(call);
      },
    };
    const { backend } = scriptedBackend([{ id: 'c1', name: 'which_workspace', arguments: {} }]);
    const cog = new Cogitator({ llm: { backends: { mock: backend } }, middleware: [watcher] });
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [whichWorkspace],
    });
    await cog.run(agent, { input: 'go', workspace: runWorkspace });
    await cog.invokeTool(whichWorkspace, {}, { workspace: agentWorkspace });
    expect(ids).toEqual(['run-ws', 'run-ws', 'agent-ws']);
  });
});
