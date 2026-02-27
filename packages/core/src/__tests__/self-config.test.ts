import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSelfConfigTools } from '../tools/self-config';

const testConfig = join(tmpdir(), `cogitator-config-test-${Date.now()}.yml`);

const parseYaml = (s: string) => JSON.parse(s);
const stringifyYaml = (o: unknown) => JSON.stringify(o, null, 2);
const validateConfig = (o: unknown) => o;

beforeEach(() => {
  writeFileSync(testConfig, JSON.stringify({ name: 'test-bot', llm: { model: 'gpt-4o' } }));
});

afterEach(() => {
  rmSync(testConfig, { force: true });
});

describe('createSelfConfigTools', () => {
  it('returns 2 tools', () => {
    const tools = createSelfConfigTools({
      configPath: testConfig,
      parseYaml,
      stringifyYaml,
      validateConfig,
    });
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(['config_read', 'config_update']);
  });

  it('config_read returns current config', async () => {
    const tools = createSelfConfigTools({
      configPath: testConfig,
      parseYaml,
      stringifyYaml,
      validateConfig,
    });
    const readTool = tools.find((t) => t.name === 'config_read')!;

    const result = (await readTool.execute({})) as { config: Record<string, unknown> };
    expect(result.config.name).toBe('test-bot');
    expect((result.config.llm as Record<string, unknown>).model).toBe('gpt-4o');
  });

  it('config_update deep-merges and writes config', async () => {
    const tools = createSelfConfigTools({
      configPath: testConfig,
      parseYaml,
      stringifyYaml,
      validateConfig,
    });
    const updateTool = tools.find((t) => t.name === 'config_update')!;

    const result = (await updateTool.execute({
      updates: { llm: { model: 'claude-4' } },
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);

    const written = JSON.parse(readFileSync(testConfig, 'utf-8'));
    expect(written.name).toBe('test-bot');
    expect(written.llm.model).toBe('claude-4');
  });

  it('config_update calls onConfigUpdated', async () => {
    const onUpdate = vi.fn();
    const tools = createSelfConfigTools({
      configPath: testConfig,
      parseYaml,
      stringifyYaml,
      validateConfig,
      onConfigUpdated: onUpdate,
    });
    const updateTool = tools.find((t) => t.name === 'config_update')!;

    await updateTool.execute({ updates: { name: 'new-name' } });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('config_update rejects invalid config', async () => {
    const strictValidate = (o: unknown) => {
      const obj = o as Record<string, unknown>;
      if (!obj.name) throw new Error('name is required');
      return obj;
    };

    const tools = createSelfConfigTools({
      configPath: testConfig,
      parseYaml,
      stringifyYaml,
      validateConfig: strictValidate,
    });
    const updateTool = tools.find((t) => t.name === 'config_update')!;

    writeFileSync(testConfig, JSON.stringify({ llm: { model: 'gpt-4o' } }));
    const result = (await updateTool.execute({
      updates: { llm: { model: 'bad' } },
    })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain('name is required');
  });
});
