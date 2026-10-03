import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PipelineStrategy } from '../../strategies/pipeline';
import { MockCoordinator, getCallContext } from './__mocks__/mock-coordinator';
import { createMockAgent, createMockSwarmAgent } from './__mocks__/mock-helpers';

describe('PipelineStrategy', () => {
  let coordinator: MockCoordinator;

  beforeEach(() => {
    coordinator = new MockCoordinator();
  });

  describe('initialization', () => {
    it('should throw when no stages provided', () => {
      expect(
        () =>
          new PipelineStrategy(coordinator, {
            stages: [],
          })
      ).toThrow('Pipeline strategy requires at least one stage');
    });

    it('should throw when stages is undefined', () => {
      expect(
        () =>
          new PipelineStrategy(coordinator, {
            stages: undefined as any,
          })
      ).toThrow('Pipeline strategy requires at least one stage');
    });

    it('should accept single stage', async () => {
      const agent = createMockAgent('processor');
      coordinator.addAgent(createMockSwarmAgent('processor'));
      coordinator.setAgentResponse('processor', 'processed');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'stage-1', agent }],
      });

      const result = await strategy.execute({ input: 'test' });
      expect(result.output).toBe('processed');
    });
  });

  describe('sequential execution', () => {
    it('should execute stages in order', async () => {
      const executionOrder: string[] = [];

      const stage1 = createMockAgent('stage-1-agent');
      const stage2 = createMockAgent('stage-2-agent');
      const stage3 = createMockAgent('stage-3-agent');

      coordinator.addAgent(createMockSwarmAgent('stage-1-agent'));
      coordinator.addAgent(createMockSwarmAgent('stage-2-agent'));
      coordinator.addAgent(createMockSwarmAgent('stage-3-agent'));

      coordinator.setAgentResponse('stage-1-agent', () => {
        executionOrder.push('stage-1');
        return 'output-1';
      });
      coordinator.setAgentResponse('stage-2-agent', () => {
        executionOrder.push('stage-2');
        return 'output-2';
      });
      coordinator.setAgentResponse('stage-3-agent', () => {
        executionOrder.push('stage-3');
        return 'output-3';
      });

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'stage-1', agent: stage1 },
          { name: 'stage-2', agent: stage2 },
          { name: 'stage-3', agent: stage3 },
        ],
      });

      await strategy.execute({ input: 'start' });
      expect(executionOrder).toEqual(['stage-1', 'stage-2', 'stage-3']);
    });

    it('should pass output from one stage to next', async () => {
      const stage1 = createMockAgent('s1');
      const stage2 = createMockAgent('s2');

      coordinator.addAgent(createMockSwarmAgent('s1'));
      coordinator.addAgent(createMockSwarmAgent('s2'));

      coordinator.setAgentResponse('s1', 'stage 1 result');
      coordinator.setAgentResponse('s2', 'final result');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'first', agent: stage1 },
          { name: 'second', agent: stage2 },
        ],
      });

      await strategy.execute({ input: 'initial' });

      const s2Call = coordinator.getLastCallFor('s2');
      expect(s2Call?.input).toContain('stage 1 result');
    });

    it('should return last stage output as final output', async () => {
      const stage1 = createMockAgent('a1');
      const stage2 = createMockAgent('a2');

      coordinator.addAgent(createMockSwarmAgent('a1'));
      coordinator.addAgent(createMockSwarmAgent('a2'));

      coordinator.setAgentResponse('a1', 'intermediate');
      coordinator.setAgentResponse('a2', 'final output here');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'pre', agent: stage1 },
          { name: 'post', agent: stage2 },
        ],
      });

      const result = await strategy.execute({ input: 'test' });
      expect(result.output).toBe('final output here');
    });
  });

  describe('pipeline context', () => {
    it('should pass pipelineContext to each stage', async () => {
      const agent = createMockAgent('ctx-agent');
      coordinator.addAgent(createMockSwarmAgent('ctx-agent'));
      coordinator.setAgentResponse('ctx-agent', 'done');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'only-stage', agent }],
      });

      await strategy.execute({ input: 'test' });

      const call = coordinator.getLastCallFor('ctx-agent');
      expect(call?.context?.pipelineContext).toMatchObject({
        stageIndex: 0,
        stageName: 'only-stage',
        totalStages: 1,
        isFirstStage: true,
        isLastStage: true,
      });
    });

    it('should track isFirstStage and isLastStage correctly', async () => {
      const agent1 = createMockAgent('a1');
      const agent2 = createMockAgent('a2');
      const agent3 = createMockAgent('a3');

      coordinator.addAgent(createMockSwarmAgent('a1'));
      coordinator.addAgent(createMockSwarmAgent('a2'));
      coordinator.addAgent(createMockSwarmAgent('a3'));

      coordinator.setAgentResponse('a1', 'out1');
      coordinator.setAgentResponse('a2', 'out2');
      coordinator.setAgentResponse('a3', 'out3');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 's1', agent: agent1 },
          { name: 's2', agent: agent2 },
          { name: 's3', agent: agent3 },
        ],
      });

      await strategy.execute({ input: 'test' });

      const call1 = coordinator.getCallsFor('a1')[0];
      const call2 = coordinator.getCallsFor('a2')[0];
      const call3 = coordinator.getCallsFor('a3')[0];

      expect(getCallContext(call1, 'pipelineContext')?.isFirstStage).toBe(true);
      expect(getCallContext(call1, 'pipelineContext')?.isLastStage).toBe(false);

      expect(getCallContext(call2, 'pipelineContext')?.isFirstStage).toBe(false);
      expect(getCallContext(call2, 'pipelineContext')?.isLastStage).toBe(false);

      expect(getCallContext(call3, 'pipelineContext')?.isFirstStage).toBe(false);
      expect(getCallContext(call3, 'pipelineContext')?.isLastStage).toBe(true);
    });

    it('should include previousOutputs in context', async () => {
      const agent1 = createMockAgent('p1');
      const agent2 = createMockAgent('p2');

      coordinator.addAgent(createMockSwarmAgent('p1'));
      coordinator.addAgent(createMockSwarmAgent('p2'));

      coordinator.setAgentResponse('p1', 'first output');
      coordinator.setAgentResponse('p2', 'second output');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'step1', agent: agent1 },
          { name: 'step2', agent: agent2 },
        ],
      });

      await strategy.execute({ input: 'test' });

      const call2 = coordinator.getLastCallFor('p2');
      expect(getCallContext(call2, 'pipelineContext')?.previousOutputs).toMatchObject({
        step1: 'first output',
      });
    });

    it('should include stageInstructions', async () => {
      const agent = createMockAgent('instr-agent');
      coordinator.addAgent(createMockSwarmAgent('instr-agent'));
      coordinator.setAgentResponse('instr-agent', 'done');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'processor', agent }],
      });

      await strategy.execute({ input: 'test' });

      const call = coordinator.getLastCallFor('instr-agent');
      expect(call?.context?.stageInstructions).toContain('processor');
      expect(call?.context?.stageInstructions).toContain('Stage 1 of 1');
    });
  });

  describe('custom stageInput', () => {
    it('should use custom stageInput function when provided', async () => {
      const agent = createMockAgent('custom-input-agent');
      coordinator.addAgent(createMockSwarmAgent('custom-input-agent'));
      coordinator.setAgentResponse('custom-input-agent', 'processed');

      const customStageInput = vi.fn().mockReturnValue('custom formatted input');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'custom', agent }],
        stageInput: customStageInput,
      });

      await strategy.execute({ input: 'original' });

      expect(customStageInput).toHaveBeenCalled();
      const call = coordinator.getLastCallFor('custom-input-agent');
      expect(call?.input).toBe('custom formatted input');
    });
  });

  describe('gate conditions', () => {
    describe('pass', () => {
      it('should pass gate when condition returns true', async () => {
        const agent = createMockAgent('gate-agent');
        coordinator.addAgent(createMockSwarmAgent('gate-agent'));
        coordinator.setAgentResponse('gate-agent', 'valid output');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [{ name: 'gated', agent, gate: true }],
          gates: {
            gated: {
              condition: (output) => typeof output === 'string' && output.includes('valid'),
              onFail: 'abort',
              maxRetries: 0,
            },
          },
        });

        const result = await strategy.execute({ input: 'test' });
        expect(result.output).toBe('valid output');
      });
    });

    describe('abort', () => {
      it('should abort pipeline when gate fails with abort action', async () => {
        const agent = createMockAgent('abort-gate-agent');
        coordinator.addAgent(createMockSwarmAgent('abort-gate-agent'));
        coordinator.setAgentResponse('abort-gate-agent', 'invalid output');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [{ name: 'abort-stage', agent, gate: true }],
          gates: {
            'abort-stage': {
              condition: () => false,
              onFail: 'abort',
              maxRetries: 0,
            },
          },
        });

        await expect(strategy.execute({ input: 'test' })).rejects.toThrow(
          "Pipeline aborted at gate 'abort-stage'"
        );
      });
    });

    describe('skip', () => {
      it('should skip to next stage on gate fail with skip action', async () => {
        const agent1 = createMockAgent('skip-agent');
        const agent2 = createMockAgent('next-agent');

        coordinator.addAgent(createMockSwarmAgent('skip-agent'));
        coordinator.addAgent(createMockSwarmAgent('next-agent'));

        coordinator.setAgentResponse('skip-agent', 'problematic output');
        coordinator.setAgentResponse('next-agent', 'final');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [
            { name: 'skip-stage', agent: agent1, gate: true },
            { name: 'next-stage', agent: agent2 },
          ],
          gates: {
            'skip-stage': {
              condition: () => false,
              onFail: 'skip',
              maxRetries: 0,
            },
          },
        });

        const result = await strategy.execute({ input: 'test' });
        expect(result.output).toBe('final');
      });
    });

    describe('retry-previous', () => {
      it('should retry previous stage when gate fails', async () => {
        const agent1 = createMockAgent('retry-agent-1');
        const agent2 = createMockAgent('retry-agent-2');

        coordinator.addAgent(createMockSwarmAgent('retry-agent-1'));
        coordinator.addAgent(createMockSwarmAgent('retry-agent-2'));

        let attempt = 0;
        coordinator.setAgentResponse('retry-agent-1', () => {
          attempt++;
          return attempt === 1 ? 'first attempt' : 'second attempt';
        });

        let gateCheck = 0;
        coordinator.setAgentResponse('retry-agent-2', () => {
          gateCheck++;
          return gateCheck === 1 ? 'fail output' : 'success output';
        });

        const strategy = new PipelineStrategy(coordinator, {
          stages: [
            { name: 'initial', agent: agent1 },
            { name: 'checked', agent: agent2, gate: true },
          ],
          gates: {
            checked: {
              condition: (output) => typeof output === 'string' && output.includes('success'),
              onFail: 'retry-previous',
              maxRetries: 3,
            },
          },
        });

        const result = await strategy.execute({ input: 'start' });
        expect(result.output).toBe('success output');
        expect(attempt).toBe(2);
      });

      it('should abort after max retries exceeded', async () => {
        const agent1 = createMockAgent('max-retry-1');
        const agent2 = createMockAgent('max-retry-2');

        coordinator.addAgent(createMockSwarmAgent('max-retry-1'));
        coordinator.addAgent(createMockSwarmAgent('max-retry-2'));

        coordinator.setAgentResponse('max-retry-1', 'retry input');
        coordinator.setAgentResponse('max-retry-2', 'always fails');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [
            { name: 'before', agent: agent1 },
            { name: 'failing', agent: agent2, gate: true },
          ],
          gates: {
            failing: {
              condition: () => false,
              onFail: 'retry-previous',
              maxRetries: 2,
            },
          },
        });

        await expect(strategy.execute({ input: 'test' })).rejects.toThrow(
          'Max retries (2) exceeded'
        );
      });
    });

    describe('goto', () => {
      it('should jump to target stage on goto action', async () => {
        const agent1 = createMockAgent('goto-1');
        const agent2 = createMockAgent('goto-2');
        const agent3 = createMockAgent('goto-3');

        coordinator.addAgent(createMockSwarmAgent('goto-1'));
        coordinator.addAgent(createMockSwarmAgent('goto-2'));
        coordinator.addAgent(createMockSwarmAgent('goto-3'));

        let stage2Calls = 0;
        coordinator.setAgentResponse('goto-1', 'first');
        coordinator.setAgentResponse('goto-2', () => {
          stage2Calls++;
          return stage2Calls === 1 ? 'need retry' : 'ok now';
        });
        coordinator.setAgentResponse('goto-3', 'final');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [
            { name: 'start', agent: agent1 },
            { name: 'middle', agent: agent2, gate: true },
            { name: 'end', agent: agent3 },
          ],
          gates: {
            middle: {
              condition: (output) => typeof output === 'string' && output.includes('ok'),
              onFail: 'goto:start',
              maxRetries: 3,
            },
          },
        });

        const result = await strategy.execute({ input: 'test' });
        expect(result.output).toBe('final');
      });

      it('should abort if goto target not found', async () => {
        const agent = createMockAgent('bad-goto');
        coordinator.addAgent(createMockSwarmAgent('bad-goto'));
        coordinator.setAgentResponse('bad-goto', 'output');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [{ name: 'only', agent, gate: true }],
          gates: {
            only: {
              condition: () => false,
              onFail: 'goto:nonexistent',
              maxRetries: 0,
            },
          },
        });

        await expect(strategy.execute({ input: 'test' })).rejects.toThrow(
          "Target stage 'nonexistent' not found"
        );
      });
    });

    describe('default gate behavior', () => {
      it('should skip on error keywords without custom gate config', async () => {
        const agent1 = createMockAgent('error-agent');
        const agent2 = createMockAgent('next-agent');

        coordinator.addAgent(createMockSwarmAgent('error-agent'));
        coordinator.addAgent(createMockSwarmAgent('next-agent'));

        coordinator.setAgentResponse('error-agent', 'An error occurred');
        coordinator.setAgentResponse('next-agent', 'recovered');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [
            { name: 'error-stage', agent: agent1, gate: true },
            { name: 'recovery', agent: agent2 },
          ],
        });

        const result = await strategy.execute({ input: 'test' });
        expect(result.output).toBe('recovered');
      });

      it('should pass gate if output has no error keywords', async () => {
        const agent = createMockAgent('clean-agent');
        coordinator.addAgent(createMockSwarmAgent('clean-agent'));
        coordinator.setAgentResponse('clean-agent', 'Success: all good');

        const strategy = new PipelineStrategy(coordinator, {
          stages: [{ name: 'clean', agent, gate: true }],
        });

        const result = await strategy.execute({ input: 'test' });
        expect(result.output).toBe('Success: all good');
      });
    });
  });

  describe('blackboard state', () => {
    it('should initialize pipeline state on blackboard', async () => {
      const agent = createMockAgent('bb-agent');
      coordinator.addAgent(createMockSwarmAgent('bb-agent'));
      coordinator.setAgentResponse('bb-agent', 'done');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'step-a', agent }],
      });

      await strategy.execute({ input: 'test' });

      const state = coordinator.blackboard.read<Record<string, unknown>>('pipeline');
      expect(state?.stages).toEqual(['step-a']);
    });

    it('should track completed stages', async () => {
      const agent1 = createMockAgent('t1');
      const agent2 = createMockAgent('t2');

      coordinator.addAgent(createMockSwarmAgent('t1'));
      coordinator.addAgent(createMockSwarmAgent('t2'));

      coordinator.setAgentResponse('t1', 'out1');
      coordinator.setAgentResponse('t2', 'out2');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'track-1', agent: agent1 },
          { name: 'track-2', agent: agent2 },
        ],
      });

      await strategy.execute({ input: 'test' });

      const state = coordinator.blackboard.read<{ completed: string[] }>('pipeline');
      expect(state?.completed).toContain('track-1');
      expect(state?.completed).toContain('track-2');
    });
  });

  describe('events', () => {
    it('should emit pipeline:stage event for each stage', async () => {
      const stageHandler = vi.fn();
      coordinator.events.on('pipeline:stage', stageHandler);

      const agent = createMockAgent('evt-agent');
      coordinator.addAgent(createMockSwarmAgent('evt-agent'));
      coordinator.setAgentResponse('evt-agent', 'done');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'event-stage', agent }],
      });

      await strategy.execute({ input: 'test' });

      expect(stageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            index: 0,
            name: 'event-stage',
            total: 1,
          }),
        })
      );
    });

    it('should emit pipeline:stage:complete after stage completes', async () => {
      const completeHandler = vi.fn();
      coordinator.events.on('pipeline:stage:complete', completeHandler);

      const agent = createMockAgent('complete-agent');
      coordinator.addAgent(createMockSwarmAgent('complete-agent'));
      coordinator.setAgentResponse('complete-agent', 'done');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'complete-stage', agent }],
      });

      await strategy.execute({ input: 'test' });

      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            index: 0,
            name: 'complete-stage',
          }),
        })
      );
    });

    it('should emit pipeline:gate:pass on successful gate', async () => {
      const gatePassHandler = vi.fn();
      coordinator.events.on('pipeline:gate:pass', gatePassHandler);

      const agent = createMockAgent('pass-gate-agent');
      coordinator.addAgent(createMockSwarmAgent('pass-gate-agent'));
      coordinator.setAgentResponse('pass-gate-agent', 'valid');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'pass-gate', agent, gate: true }],
        gates: {
          'pass-gate': {
            condition: () => true,
            onFail: 'abort',
            maxRetries: 0,
          },
        },
      });

      await strategy.execute({ input: 'test' });

      expect(gatePassHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stage: 'pass-gate' }),
        })
      );
    });

    it('should emit pipeline:gate:fail on failed gate', async () => {
      const gateFailHandler = vi.fn();
      coordinator.events.on('pipeline:gate:fail', gateFailHandler);

      const agent1 = createMockAgent('fail-gate-agent');
      const agent2 = createMockAgent('next-agent');

      coordinator.addAgent(createMockSwarmAgent('fail-gate-agent'));
      coordinator.addAgent(createMockSwarmAgent('next-agent'));

      coordinator.setAgentResponse('fail-gate-agent', 'invalid');
      coordinator.setAgentResponse('next-agent', 'done');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'fail-gate', agent: agent1, gate: true },
          { name: 'next', agent: agent2 },
        ],
        gates: {
          'fail-gate': {
            condition: () => false,
            onFail: 'skip',
            maxRetries: 0,
          },
        },
      });

      await strategy.execute({ input: 'test' });

      expect(gateFailHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stage: 'fail-gate',
            reason: 'Gate condition failed',
          }),
        })
      );
    });
  });

  describe('result structure', () => {
    it('should return pipelineOutputs map', async () => {
      const agent1 = createMockAgent('out1');
      const agent2 = createMockAgent('out2');

      coordinator.addAgent(createMockSwarmAgent('out1'));
      coordinator.addAgent(createMockSwarmAgent('out2'));

      coordinator.setAgentResponse('out1', 'output from stage 1');
      coordinator.setAgentResponse('out2', 'output from stage 2');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [
          { name: 'stage-1', agent: agent1 },
          { name: 'stage-2', agent: agent2 },
        ],
      });

      const result = await strategy.execute({ input: 'test' });

      expect(result.pipelineOutputs).toBeInstanceOf(Map);
      expect(result.pipelineOutputs?.get('stage-1')).toBe('output from stage 1');
      expect(result.pipelineOutputs?.get('stage-2')).toBe('output from stage 2');
    });

    it('should include agentResults keyed by stage name', async () => {
      const agent = createMockAgent('res-agent');
      coordinator.addAgent(createMockSwarmAgent('res-agent'));
      coordinator.setAgentResponse('res-agent', 'result');

      const strategy = new PipelineStrategy(coordinator, {
        stages: [{ name: 'result-stage', agent }],
      });

      const result = await strategy.execute({ input: 'test' });

      expect(result.agentResults.has('result-stage')).toBe(true);
      expect(result.agentResults.get('result-stage')?.output).toBe('result');
    });
  });
});
