import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobQueue } from '../queue';
import type { SerializedAgent, SerializedWorkflow, SerializedSwarm } from '../types';

const mockAdd = vi.fn();
const mockGetJob = vi.fn();
const mockGetWaitingCount = vi.fn();
const mockGetActiveCount = vi.fn();
const mockGetCompletedCount = vi.fn();
const mockGetFailedCount = vi.fn();
const mockGetDelayedCount = vi.fn();
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockClean = vi.fn();
const mockClose = vi.fn();

vi.mock('bullmq', () => {
  class Queue {
    add = mockAdd;
    getJob = mockGetJob;
    getWaitingCount = mockGetWaitingCount;
    getActiveCount = mockGetActiveCount;
    getCompletedCount = mockGetCompletedCount;
    getFailedCount = mockGetFailedCount;
    getDelayedCount = mockGetDelayedCount;
    pause = mockPause;
    resume = mockResume;
    clean = mockClean;
    close = mockClose;
  }
  return { Queue };
});

describe('JobQueue', () => {
  let queue: JobQueue;

  const mockAgentConfig: SerializedAgent = {
    name: 'TestAgent',
    instructions: 'Test instructions',
    model: 'gpt-4',
    provider: 'openai',
    tools: [],
  };

  const mockWorkflowConfig: SerializedWorkflow = {
    id: 'workflow_123',
    name: 'TestWorkflow',
    nodes: [],
    edges: [],
  };

  const mockSwarmConfig: SerializedSwarm = {
    topology: 'collaborative',
    agents: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new JobQueue({
      redis: { host: 'localhost', port: 6379 },
    });

    mockAdd.mockResolvedValue({ id: 'job_123', data: {} });
    mockGetJob.mockResolvedValue({ id: 'job_123', getState: vi.fn().mockResolvedValue('active') });
    mockGetWaitingCount.mockResolvedValue(5);
    mockGetActiveCount.mockResolvedValue(2);
    mockGetCompletedCount.mockResolvedValue(100);
    mockGetFailedCount.mockResolvedValue(3);
    mockGetDelayedCount.mockResolvedValue(1);
  });

  afterEach(async () => {
    await queue.close();
  });

  describe('addAgentJob', () => {
    it('adds an agent job to the queue', async () => {
      await queue.addAgentJob(mockAgentConfig, 'Hello');

      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({
          type: 'agent',
          agentConfig: mockAgentConfig,
          input: 'Hello',
        }),
        expect.any(Object)
      );
    });

    it('includes optional threadId', async () => {
      await queue.addAgentJob(mockAgentConfig, 'Hello', { threadId: 'thread_custom' });

      expect(mockAdd).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({
          threadId: 'thread_custom',
        }),
        expect.any(Object)
      );
    });

    it('includes priority and delay', async () => {
      await queue.addAgentJob(mockAgentConfig, 'Hello', { priority: 1, delay: 5000 });

      expect(mockAdd).toHaveBeenCalledWith(
        'agent',
        expect.any(Object),
        expect.objectContaining({
          priority: 1,
          delay: 5000,
        })
      );
    });

    it('includes metadata', async () => {
      await queue.addAgentJob(mockAgentConfig, 'Hello', {
        metadata: { userId: 'user_123' },
      });

      expect(mockAdd).toHaveBeenCalledWith(
        'agent',
        expect.objectContaining({
          metadata: { userId: 'user_123' },
        }),
        expect.any(Object)
      );
    });
  });

  describe('addWorkflowJob', () => {
    it('adds a workflow job to the queue', async () => {
      await queue.addWorkflowJob(mockWorkflowConfig, { key: 'value' });

      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledWith(
        'workflow',
        expect.objectContaining({
          type: 'workflow',
          workflowConfig: mockWorkflowConfig,
          input: { key: 'value' },
        }),
        expect.any(Object)
      );
    });

    it('includes optional runId', async () => {
      await queue.addWorkflowJob(mockWorkflowConfig, {}, { runId: 'run_custom' });

      expect(mockAdd).toHaveBeenCalledWith(
        'workflow',
        expect.objectContaining({
          runId: 'run_custom',
        }),
        expect.any(Object)
      );
    });
  });

  describe('addSwarmJob', () => {
    it('adds a swarm job to the queue', async () => {
      await queue.addSwarmJob(mockSwarmConfig, 'Task input');

      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledWith(
        'swarm',
        expect.objectContaining({
          type: 'swarm',
          swarmConfig: mockSwarmConfig,
          input: 'Task input',
        }),
        expect.any(Object)
      );
    });
  });

  describe('addSwarmAgentJob', () => {
    it('adds a swarm agent job to the queue', async () => {
      await queue.addSwarmAgentJob('swarm_123', 'agent1', mockAgentConfig, 'Task');

      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledWith(
        'swarm-agent',
        expect.objectContaining({
          type: 'swarm-agent',
          swarmId: 'swarm_123',
          agentName: 'agent1',
          agentConfig: mockAgentConfig,
          input: 'Task',
        }),
        expect.any(Object)
      );
    });

    it('includes state keys', async () => {
      await queue.addSwarmAgentJob('swarm_123', 'agent1', mockAgentConfig, 'Task', {
        stateKeys: {
          blackboard: 'custom:blackboard',
          messages: 'custom:messages',
          results: 'custom:results',
        },
      });

      expect(mockAdd).toHaveBeenCalledWith(
        'swarm-agent',
        expect.objectContaining({
          stateKeys: {
            blackboard: 'custom:blackboard',
            messages: 'custom:messages',
            results: 'custom:results',
          },
        }),
        expect.any(Object)
      );
    });
  });

  describe('getJob', () => {
    it('retrieves a job by ID', async () => {
      const job = await queue.getJob('job_123');

      expect(mockGetJob).toHaveBeenCalledWith('job_123');
      expect(job).toBeDefined();
    });

    it('returns undefined for non-existent job', async () => {
      mockGetJob.mockResolvedValueOnce(undefined);

      const job = await queue.getJob('nonexistent');

      expect(job).toBeUndefined();
    });
  });

  describe('getJobState', () => {
    it('returns job state', async () => {
      const state = await queue.getJobState('job_123');

      expect(state).toBe('active');
    });

    it('returns unknown for non-existent job', async () => {
      mockGetJob.mockResolvedValueOnce(undefined);

      const state = await queue.getJobState('nonexistent');

      expect(state).toBe('unknown');
    });
  });

  describe('getMetrics', () => {
    it('returns queue metrics', async () => {
      const metrics = await queue.getMetrics();

      expect(metrics).toEqual({
        waiting: 5,
        active: 2,
        completed: 100,
        failed: 3,
        delayed: 1,
        depth: 6,
        workerCount: 0,
      });
    });
  });

  describe('pause/resume', () => {
    it('pauses the queue', async () => {
      await queue.pause();

      expect(mockPause).toHaveBeenCalledTimes(1);
    });

    it('resumes the queue', async () => {
      await queue.resume();

      expect(mockResume).toHaveBeenCalledTimes(1);
    });
  });

  describe('clean', () => {
    it('cleans old jobs', async () => {
      mockClean.mockResolvedValueOnce(['job_1', 'job_2']);

      const cleaned = await queue.clean(3600000, 100, 'completed');

      expect(mockClean).toHaveBeenCalledWith(3600000, 100, 'completed');
      expect(cleaned).toEqual(['job_1', 'job_2']);
    });
  });

  describe('close', () => {
    it('closes the queue connection', async () => {
      await queue.close();

      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
