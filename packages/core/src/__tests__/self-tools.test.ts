import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSelfTools, loadCustomTools } from '../tools/self-tools';

const testDir = join(tmpdir(), `cogitator-self-tools-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('createSelfTools', () => {
  it('returns 4 tools', () => {
    const tools = createSelfTools({ toolsDir: testDir });
    expect(tools).toHaveLength(4);

    const names = tools.map((t) => t.name);
    expect(names).toContain('create_tool');
    expect(names).toContain('test_tool');
    expect(names).toContain('list_custom_tools');
    expect(names).toContain('delete_tool');
  });

  it('create_tool writes and validates a valid tool', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const createTool = tools.find((t) => t.name === 'create_tool')!;

    const code = `export default {
  name: 'greet',
  description: 'Greets a person',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  execute: async ({ name }) => ({ message: 'Hello ' + name })
};`;

    const result = (await createTool.execute({ name: 'greet', code })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, 'greet.mjs'))).toBe(true);
  });

  it('create_tool rejects tool without execute', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const createTool = tools.find((t) => t.name === 'create_tool')!;

    const code = `export default { name: 'bad', description: 'no execute' };`;
    const result = (await createTool.execute({ name: 'bad', code })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain('execute');
    expect(existsSync(join(testDir, 'bad.mjs'))).toBe(false);
  });

  it('create_tool rejects syntactically invalid code', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const createTool = tools.find((t) => t.name === 'create_tool')!;

    const result = (await createTool.execute({
      name: 'broken',
      code: 'export default {{{',
    })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(existsSync(join(testDir, 'broken.mjs'))).toBe(false);
  });

  it('test_tool runs a tool and returns result', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const createTool = tools.find((t) => t.name === 'create_tool')!;
    const testTool = tools.find((t) => t.name === 'test_tool')!;

    const code = `export default {
  name: 'adder',
  description: 'Adds two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  execute: async ({ a, b }) => ({ sum: a + b })
};`;
    await createTool.execute({ name: 'adder', code });

    const result = (await testTool.execute({
      name: 'adder',
      params: { a: 3, b: 7 },
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ sum: 10 });
    expect(typeof result.durationMs).toBe('number');
  });

  it('test_tool returns error for non-existent tool', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const testTool = tools.find((t) => t.name === 'test_tool')!;

    const result = (await testTool.execute({
      name: 'nope',
      params: {},
    })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('list_custom_tools returns saved tools', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const createTool = tools.find((t) => t.name === 'create_tool')!;
    const listTools = tools.find((t) => t.name === 'list_custom_tools')!;

    const code = `export default {
  name: 'echo',
  description: 'Echoes input',
  parameters: { type: 'object', properties: {} },
  execute: async (p) => p
};`;
    await createTool.execute({ name: 'echo', code });

    const result = (await listTools.execute({})) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('echo');
  });

  it('delete_tool removes a tool', async () => {
    const tools = createSelfTools({ toolsDir: testDir });
    const createTool = tools.find((t) => t.name === 'create_tool')!;
    const deleteTool = tools.find((t) => t.name === 'delete_tool')!;

    const code = `export default {
  name: 'tmp',
  description: 'Temporary',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({})
};`;
    await createTool.execute({ name: 'tmp', code });
    expect(existsSync(join(testDir, 'tmp.mjs'))).toBe(true);

    const result = (await deleteTool.execute({ name: 'tmp' })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, 'tmp.mjs'))).toBe(false);
  });
});

describe('loadCustomTools', () => {
  it('returns empty array for non-existent dir', async () => {
    const tools = await loadCustomTools('/tmp/definitely-not-here-' + Date.now());
    expect(tools).toEqual([]);
  });

  it('loads valid tools from directory', async () => {
    const code = `export default {
  name: 'loaded',
  description: 'Loaded from disk',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true })
};`;
    writeFileSync(join(testDir, 'loaded.mjs'), code);

    const tools = await loadCustomTools(testDir);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('loaded');
  });

  it('skips invalid tool files', async () => {
    writeFileSync(join(testDir, 'bad.mjs'), 'export default { nope: true };');

    const tools = await loadCustomTools(testDir);
    expect(tools).toHaveLength(0);
  });
});
