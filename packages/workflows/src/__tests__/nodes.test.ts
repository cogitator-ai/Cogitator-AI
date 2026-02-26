import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import {
  functionNode,
  customNode,
  agentNode,
  toolNode,
  InMemoryCheckpointStore,
  FileCheckpointStore,
  createCheckpointId,
} from '../index';
import type { WorkflowCheckpoint, Tool, NodeContext } from '@cogitator-ai/types';
import type { Cogitator, Agent } from '@cogitator-ai/core';

interface TestState {
  count: number;
  label?: string;
}

function makeCtx(overrides: Partial<NodeContext<TestState>> = {}): NodeContext<TestState> {
  return {
    state: { count: 0 },
    nodeId: 'test-node',
    workflowId: 'wf-1',
    step: 0,
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    id: 'ckpt-1',
    workflowId: 'wf-1',
    workflowName: 'test-workflow',
    state: { count: 1 },
    completedNodes: ['step1'],
    nodeResults: { step1: 'ok' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('functionNode', () => {
  it('executes simple function and returns output', async () => {
    const node = functionNode<TestState, number>('double', async (state) => state.count * 2);

    expect(node.name).toBe('double');
    const result = await node.fn(makeCtx({ state: { count: 5 } }));
    expect(result.output).toBe(10);
    expect(result.state).toBeUndefined();
  });

  it('passes input to function', async () => {
    const node = functionNode<TestState, string>('greet', async (_state, input) => {
      return `hello ${input}`;
    });

    const result = await node.fn(makeCtx({ input: 'world' }));
    expect(result.output).toBe('hello world');
  });

  it('applies stateMapper when provided', async () => {
    const node = functionNode<TestState, number>('inc', async (state) => state.count + 1, {
      stateMapper: (output) => ({ count: output as number }),
    });

    const result = await node.fn(makeCtx({ state: { count: 7 } }));
    expect(result.output).toBe(8);
    expect(result.state).toEqual({ count: 8 });
  });

  it('propagates errors from the function', async () => {
    const node = functionNode<TestState>('fail', async () => {
      throw new Error('boom');
    });

    await expect(node.fn(makeCtx())).rejects.toThrow('boom');
  });
});

describe('customNode', () => {
  it('gives full control over context and result', async () => {
    const node = customNode<TestState>('custom', async (ctx) => ({
      state: { count: ctx.state.count + 100 },
      output: `step=${ctx.step}`,
    }));

    expect(node.name).toBe('custom');
    const result = await node.fn(makeCtx({ state: { count: 1 }, step: 3 }));
    expect(result.state).toEqual({ count: 101 });
    expect(result.output).toBe('step=3');
  });

  it('can return empty result', async () => {
    const node = customNode<TestState>('noop', async () => ({}));
    const result = await node.fn(makeCtx());
    expect(result.state).toBeUndefined();
    expect(result.output).toBeUndefined();
  });
});

describe('agentNode', () => {
  const mockAgent: Agent = {
    name: 'test-agent',
    instructions: 'do stuff',
    tools: [],
  } as Agent;

  it('throws when cogitator is not injected', async () => {
    const node = agentNode(mockAgent);
    const ctx = makeCtx();

    await expect(node.fn(ctx)).rejects.toThrow(
      'agentNode "test-agent" requires a Cogitator instance'
    );
  });

  it('runs agent via cogitator and returns output', async () => {
    const mockCogitator = {
      run: vi.fn().mockResolvedValue({ output: 'agent said hi' }),
    } as unknown as Cogitator;

    const node = agentNode(mockAgent);
    const ctx = { ...makeCtx({ input: 'hello' }), cogitator: mockCogitator };

    const result = await node.fn(ctx);
    expect(result.output).toBe('agent said hi');
    expect(mockCogitator.run).toHaveBeenCalledWith(mockAgent, { input: 'hello' });
  });

  it('uses inputMapper to build input string', async () => {
    const mockCogitator = {
      run: vi.fn().mockResolvedValue({ output: 'ok' }),
    } as unknown as Cogitator;

    const node = agentNode<TestState>(mockAgent, {
      inputMapper: (state) => `count is ${state.count}`,
    });
    const ctx = { ...makeCtx({ state: { count: 42 } }), cogitator: mockCogitator };

    await node.fn(ctx);
    expect(mockCogitator.run).toHaveBeenCalledWith(mockAgent, { input: 'count is 42' });
  });

  it('applies stateMapper to agent result', async () => {
    const mockCogitator = {
      run: vi.fn().mockResolvedValue({ output: 'result-text' }),
    } as unknown as Cogitator;

    const node = agentNode<TestState>(mockAgent, {
      stateMapper: (res) => ({ label: res.output }),
    });
    const ctx = { ...makeCtx(), cogitator: mockCogitator };

    const result = await node.fn(ctx);
    expect(result.state).toEqual({ label: 'result-text' });
  });

  it('serializes non-string input as JSON', async () => {
    const mockCogitator = {
      run: vi.fn().mockResolvedValue({ output: 'ok' }),
    } as unknown as Cogitator;

    const node = agentNode(mockAgent);
    const ctx = { ...makeCtx({ input: { foo: 'bar' } }), cogitator: mockCogitator };

    await node.fn(ctx);
    expect(mockCogitator.run).toHaveBeenCalledWith(mockAgent, {
      input: JSON.stringify({ foo: 'bar' }),
    });
  });

  it('falls back to serialized state when no input', async () => {
    const mockCogitator = {
      run: vi.fn().mockResolvedValue({ output: 'ok' }),
    } as unknown as Cogitator;

    const node = agentNode(mockAgent);
    const state = { count: 5 };
    const ctx = { ...makeCtx({ state }), cogitator: mockCogitator };

    await node.fn(ctx);
    expect(mockCogitator.run).toHaveBeenCalledWith(mockAgent, {
      input: JSON.stringify(state),
    });
  });

  it('passes runOptions to cogitator.run', async () => {
    const mockCogitator = {
      run: vi.fn().mockResolvedValue({ output: 'ok' }),
    } as unknown as Cogitator;

    const node = agentNode(mockAgent, {
      runOptions: { maxSteps: 3 },
    });
    const ctx = { ...makeCtx({ input: 'go' }), cogitator: mockCogitator };

    await node.fn(ctx);
    expect(mockCogitator.run).toHaveBeenCalledWith(mockAgent, {
      input: 'go',
      maxSteps: 3,
    });
  });
});

describe('toolNode', () => {
  const mockTool: Tool<{ x: number }, number> = {
    name: 'multiply',
    description: 'multiply by 2',
    parameters: z.object({ x: z.number() }),
    execute: vi.fn(async ({ x }) => x * 2),
  };

  it('executes tool with mapped args and returns result', async () => {
    const node = toolNode<TestState, { x: number }>(mockTool, {
      argsMapper: (state) => ({ x: state.count }),
    });

    expect(node.name).toBe('multiply');
    const result = await node.fn(makeCtx({ state: { count: 7 } }));
    expect(result.output).toBe(14);
    expect(mockTool.execute).toHaveBeenCalled();
  });

  it('applies stateMapper to tool result', async () => {
    const node = toolNode<TestState, { x: number }>(mockTool, {
      argsMapper: (state) => ({ x: state.count }),
      stateMapper: (result) => ({ count: result as number }),
    });

    const result = await node.fn(makeCtx({ state: { count: 3 } }));
    expect(result.state).toEqual({ count: 6 });
  });

  it('passes workflowId as runId in tool context', async () => {
    const spyTool: Tool<{ x: number }, number> = {
      name: 'spy',
      description: 'spy tool',
      parameters: z.object({ x: z.number() }),
      execute: vi.fn(async ({ x }, toolCtx) => {
        expect(toolCtx.runId).toBe('wf-42');
        expect(toolCtx.agentId).toBe('workflow');
        return x;
      }),
    };

    const node = toolNode<TestState, { x: number }>(spyTool, {
      argsMapper: () => ({ x: 1 }),
    });

    await node.fn(makeCtx({ workflowId: 'wf-42' }));
    expect(spyTool.execute).toHaveBeenCalled();
  });

  it('passes input to argsMapper', async () => {
    const argsMapper = vi.fn((_state: TestState, input?: unknown) => ({
      x: (input as number) ?? 0,
    }));

    const node = toolNode<TestState, { x: number }>(mockTool, { argsMapper });
    await node.fn(makeCtx({ input: 99 }));
    expect(argsMapper).toHaveBeenCalledWith({ count: 0 }, 99);
  });
});

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it('saves and loads a checkpoint', async () => {
    const ckpt = makeCheckpoint();
    await store.save(ckpt);

    const loaded = await store.load('ckpt-1');
    expect(loaded).toEqual(ckpt);
  });

  it('returns null for unknown id', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('returns a copy, not a reference', async () => {
    const ckpt = makeCheckpoint();
    await store.save(ckpt);

    const a = await store.load('ckpt-1');
    const b = await store.load('ckpt-1');
    expect(a).not.toBe(b);
  });

  it('lists checkpoints by workflow name sorted by timestamp desc', async () => {
    await store.save(makeCheckpoint({ id: 'a', workflowName: 'wf-a', timestamp: 100 }));
    await store.save(makeCheckpoint({ id: 'b', workflowName: 'wf-a', timestamp: 300 }));
    await store.save(makeCheckpoint({ id: 'c', workflowName: 'wf-a', timestamp: 200 }));
    await store.save(makeCheckpoint({ id: 'd', workflowName: 'wf-b', timestamp: 400 }));

    const list = await store.list('wf-a');
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('b');
    expect(list[1].id).toBe('c');
    expect(list[2].id).toBe('a');
  });

  it('returns empty array for unknown workflow name', async () => {
    const list = await store.list('unknown');
    expect(list).toEqual([]);
  });

  it('deletes a checkpoint', async () => {
    await store.save(makeCheckpoint({ id: 'x' }));
    await store.delete('x');
    expect(await store.load('x')).toBeNull();
  });

  it('delete is idempotent for missing ids', async () => {
    await expect(store.delete('missing')).resolves.toBeUndefined();
  });

  it('clears all checkpoints', async () => {
    await store.save(makeCheckpoint({ id: 'a' }));
    await store.save(makeCheckpoint({ id: 'b' }));
    store.clear();
    expect(await store.load('a')).toBeNull();
    expect(await store.load('b')).toBeNull();
  });
});

describe('FileCheckpointStore', () => {
  let tmpDir: string;
  let store: FileCheckpointStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cogitator-ckpt-'));
    store = new FileCheckpointStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads a checkpoint from disk', async () => {
    const ckpt = makeCheckpoint();
    await store.save(ckpt);

    const loaded = await store.load('ckpt-1');
    expect(loaded).toEqual(ckpt);
  });

  it('returns null for unknown id', async () => {
    const loaded = await store.load('nonexistent');
    expect(loaded).toBeNull();
  });

  it('lists checkpoints filtered by workflow name', async () => {
    await store.save(makeCheckpoint({ id: 'a', workflowName: 'alpha', timestamp: 10 }));
    await store.save(makeCheckpoint({ id: 'b', workflowName: 'alpha', timestamp: 30 }));
    await store.save(makeCheckpoint({ id: 'c', workflowName: 'beta', timestamp: 20 }));

    const list = await store.list('alpha');
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('b');
    expect(list[1].id).toBe('a');
  });

  it('deletes a checkpoint file', async () => {
    await store.save(makeCheckpoint({ id: 'del-me' }));
    await store.delete('del-me');
    expect(await store.load('del-me')).toBeNull();
  });

  it('delete is idempotent for missing ids', async () => {
    await expect(store.delete('ghost')).resolves.toBeUndefined();
  });

  it('sanitizes path traversal in id', async () => {
    const ckpt = makeCheckpoint({ id: '../../etc/passwd' });
    await store.save(ckpt);

    const files = await fs.readdir(tmpDir);
    for (const f of files) {
      expect(f).not.toContain('..');
    }

    const loaded = await store.load('../../etc/passwd');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('../../etc/passwd');
  });

  it('creates directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'sub', 'dir');
    const nestedStore = new FileCheckpointStore(nested);
    await nestedStore.save(makeCheckpoint({ id: 'nested-1' }));
    const loaded = await nestedStore.load('nested-1');
    expect(loaded).not.toBeNull();
  });
});

describe('createCheckpointId', () => {
  it('generates string starting with ckpt_', () => {
    const id = createCheckpointId();
    expect(id).toMatch(/^ckpt_/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createCheckpointId()));
    expect(ids.size).toBe(100);
  });

  it('has consistent length', () => {
    const a = createCheckpointId();
    const b = createCheckpointId();
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThan(5);
  });
});
