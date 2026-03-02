import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSchedulerTools } from '../tools/scheduler-tools';

describe('scheduler tools', () => {
  const mockStore = {
    schedule: vi.fn().mockResolvedValue('task_1'),
    cancel: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockResolvedValue([]),
    getOverdue: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    getByWorkflow: vi.fn().mockResolvedValue([]),
    getByRun: vi.fn().mockResolvedValue([]),
    markFired: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(0),
    onFire: vi.fn().mockReturnValue(() => {}),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates three tools', () => {
    const tools = createSchedulerTools({ store: mockStore });
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['schedule_task', 'list_tasks', 'cancel_task']);
  });

  it('schedule_task creates one-shot task with delay', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;
    const before = Date.now();

    const result = await scheduleTool.execute(
      { description: 'Remind to call mom', delay: '20m', channel: 'telegram' },
      {} as never
    );

    expect(result).toMatchObject({ scheduled: true, id: 'task_1' });
    expect(mockStore.schedule).toHaveBeenCalledOnce();

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.description).toBe('Remind to call mom');
    expect(entry.metadata.channel).toBe('telegram');
    expect(entry.type).toBe('fixed');
    expect(entry.workflowId).toBe('heartbeat');
    expect(entry.runId).toBe('scheduler');
    expect(entry.firesAt).toBeGreaterThanOrEqual(before + 20 * 60_000);
  });

  it('schedule_task creates recurring cron task', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    const result = await scheduleTool.execute(
      { description: 'Send daily news', cron: '0 12 * * *', channel: 'telegram' },
      {} as never
    );

    expect(result).toMatchObject({ scheduled: true, id: 'task_1' });

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.cron).toBe('0 12 * * *');
    expect(entry.type).toBe('cron');
    expect(entry.metadata.description).toBe('Send daily news');
  });

  it('schedule_task creates task with ISO datetime', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;
    const target = '2030-01-15T10:00:00Z';

    await scheduleTool.execute({ description: 'New year meeting', at: target }, {} as never);

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.firesAt).toBe(new Date(target).getTime());
    expect(entry.type).toBe('fixed');
  });

  it('schedule_task uses default channel and userId', async () => {
    const tools = createSchedulerTools({
      store: mockStore,
      defaultChannel: 'slack',
      defaultUserId: 'user_42',
    });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await scheduleTool.execute({ description: 'Test', delay: '5m' }, {} as never);

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.channel).toBe('slack');
    expect(entry.metadata.userId).toBe('user_42');
  });

  it('schedule_task throws if no timing mode is provided', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await expect(scheduleTool.execute({ description: 'Bad task' }, {} as never)).rejects.toThrow(
      'Provide exactly one of: delay, cron, or at'
    );
  });

  it('schedule_task throws if multiple timing modes are provided', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await expect(
      scheduleTool.execute({ description: 'Bad', delay: '5m', cron: '* * * * *' }, {} as never)
    ).rejects.toThrow('Provide exactly one of: delay, cron, or at');
  });

  it('schedule_task throws on invalid cron expression', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await expect(
      scheduleTool.execute({ description: 'Bad cron', cron: 'not-a-cron' }, {} as never)
    ).rejects.toThrow('Invalid cron expression');
  });

  it('schedule_task throws on invalid ISO datetime', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await expect(
      scheduleTool.execute({ description: 'Bad date', at: 'not-a-date' }, {} as never)
    ).rejects.toThrow('Invalid ISO datetime');
  });

  it('list_tasks returns formatted list', async () => {
    mockStore.getPending.mockResolvedValueOnce([
      {
        id: 't1',
        firesAt: Date.now() + 60_000,
        metadata: { description: 'News' },
        cron: '0 12 * * *',
      },
      {
        id: 't2',
        firesAt: Date.now() + 120_000,
        metadata: { description: 'Backup' },
      },
    ]);

    const tools = createSchedulerTools({ store: mockStore });
    const listTool = tools.find((t) => t.name === 'list_tasks')!;
    const result = await listTool.execute({}, {} as never);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ id: 't1', description: 'News', cron: '0 12 * * *' });
    expect(result.tasks[1]).toMatchObject({ id: 't2', description: 'Backup' });
    expect(result.tasks[1]).not.toHaveProperty('cron');
  });

  it('list_tasks returns empty array when no pending tasks', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const listTool = tools.find((t) => t.name === 'list_tasks')!;
    const result = await listTool.execute({}, {} as never);
    expect(result.tasks).toEqual([]);
  });

  it('schedule_task uses context.channelType and context.userId as fallbacks', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await scheduleTool.execute(
      { description: 'Context test', delay: '1m' },
      {
        agentId: 'a1',
        runId: 'r1',
        signal: new AbortController().signal,
        channelType: 'telegram',
        channelId: 'chat_123',
        userId: 'user_99',
      }
    );

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.channel).toBe('telegram');
    expect(entry.metadata.channelId).toBe('chat_123');
    expect(entry.metadata.userId).toBe('user_99');
  });

  it('schedule_task prefers explicit params over context', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await scheduleTool.execute(
      { description: 'Override test', delay: '1m', channel: 'discord', userId: 'explicit_user' },
      {
        agentId: 'a1',
        runId: 'r1',
        signal: new AbortController().signal,
        channelType: 'telegram',
        channelId: 'chat_123',
        userId: 'user_99',
      }
    );

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.channel).toBe('discord');
    expect(entry.metadata.userId).toBe('explicit_user');
    expect(entry.metadata.channelId).toBe('chat_123');
  });

  it('schedule_task stores channelId from context', async () => {
    const tools = createSchedulerTools({
      store: mockStore,
      defaultChannel: 'slack',
      defaultUserId: 'default',
    });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await scheduleTool.execute(
      { description: 'ChannelId test', delay: '5m' },
      {
        agentId: 'a1',
        runId: 'r1',
        signal: new AbortController().signal,
        channelId: 'C12345',
      }
    );

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.channelId).toBe('C12345');
    expect(entry.metadata.channel).toBe('slack');
  });

  it('schedule_task stores bestEffort in metadata', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await scheduleTool.execute(
      { description: 'Fire and forget', delay: '5m', bestEffort: true },
      {} as never
    );

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.bestEffort).toBe(true);
  });

  it('schedule_task omits bestEffort from metadata when false', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const scheduleTool = tools.find((t) => t.name === 'schedule_task')!;

    await scheduleTool.execute(
      { description: 'Normal task', delay: '5m', bestEffort: false },
      {} as never
    );

    const entry = mockStore.schedule.mock.calls[0][0];
    expect(entry.metadata.bestEffort).toBeUndefined();
  });

  it('cancel_task cancels by ID', async () => {
    const tools = createSchedulerTools({ store: mockStore });
    const cancelTool = tools.find((t) => t.name === 'cancel_task')!;

    const result = await cancelTool.execute({ id: 'task_1' }, {} as never);

    expect(result).toEqual({ cancelled: true, id: 'task_1' });
    expect(mockStore.cancel).toHaveBeenCalledWith('task_1');
  });
});
