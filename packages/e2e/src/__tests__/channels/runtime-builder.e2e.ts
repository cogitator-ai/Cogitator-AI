import { describe, it, expect, afterEach } from 'vitest';
import { RuntimeBuilder } from '@cogitator-ai/channels';
import type { BuiltRuntime } from '@cogitator-ai/channels';

describe('RuntimeBuilder E2E', () => {
  let runtime: BuiltRuntime | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.cleanup();
      runtime = null;
    }
  });

  it('builds runtime from minimal config', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'test-assistant',
        personality: 'Helpful bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    expect(runtime.agent).toBeDefined();
    expect(runtime.agent.name).toBe('test-assistant');
    expect(runtime.gateway).toBeDefined();
    expect(runtime.cogitator).toBeDefined();
  });

  it('includes memory tools when knowledge graph enabled', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'memory-bot',
        personality: 'Bot with memory',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:', knowledgeGraph: true },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    const toolNames = runtime.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('remember');
    expect(toolNames).toContain('recall');
    expect(toolNames).toContain('forget');
  });

  it('excludes memory tools when knowledge graph disabled', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'no-memory-bot',
        personality: 'Bot without memory',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:', knowledgeGraph: false },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    const toolNames = runtime.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain('remember');
    expect(toolNames).not.toContain('recall');
    expect(toolNames).not.toContain('forget');
  });

  it('includes scheduler tools and hint when scheduler enabled', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'scheduler-bot',
        personality: 'Bot with scheduler',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: { scheduler: true },
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    const toolNames = runtime.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('schedule_task');
    expect(toolNames).toContain('list_tasks');
    expect(toolNames).toContain('cancel_task');
    expect(runtime.agent.instructions).toContain('schedule_task');
    expect(runtime.scheduler).not.toBeNull();
  });

  it('includes lookup_capabilities tool', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'capable-bot',
        personality: 'Bot with self-awareness',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: { webSearch: true },
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    const toolNames = runtime.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('lookup_capabilities');
  });

  it('always includes calculator and datetime tools', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'basic-bot',
        personality: 'Basic bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    const toolNames = runtime.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('calculator');
    expect(toolNames).toContain('datetime');
  });

  it('returns null scheduler by default', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'no-scheduler-bot',
        personality: 'Bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    expect(runtime.scheduler).toBeNull();
  });

  it('embeds personality in agent instructions', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'persona-bot',
        personality: 'You are a pirate. Speak in pirate speak.',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    expect(runtime.agent.instructions).toContain('You are a pirate');
  });

  it('includes device tools when deviceTools enabled', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'device-bot',
        personality: 'Bot with device access',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: { deviceTools: true },
        memory: { adapter: 'sqlite', path: ':memory:' },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();

    const toolNames = runtime.agent.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('clipboard_read');
    expect(toolNames).toContain('clipboard_write');
    expect(toolNames).toContain('system_info');
    expect(toolNames).toContain('screenshot');
  });

  it('cleanup closes all resources without throwing', async () => {
    const builder = new RuntimeBuilder(
      {
        name: 'cleanup-bot',
        personality: 'Bot',
        llm: { provider: 'google', model: 'google/gemini-2.5-flash' },
        channels: {},
        capabilities: {},
        memory: { adapter: 'sqlite', path: ':memory:', knowledgeGraph: true },
      },
      { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? 'test-key' }
    );

    runtime = await builder.build();
    await runtime.cleanup();
    runtime = null;
  });
});
