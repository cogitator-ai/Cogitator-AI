import { describe, it, expect, beforeAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import type { Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Swarms: Multi-Agent Coordination', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  it(
    'round-robin distributes across agents on consecutive runs',
    { timeout: 120_000 },
    async () => {
      const agentA = createTestAgent({
        name: 'alpha',
        instructions: 'Reply with exactly: ALPHA_OK',
      });
      const agentB = createTestAgent({ name: 'beta', instructions: 'Reply with exactly: BETA_OK' });
      const agentC = createTestAgent({
        name: 'gamma',
        instructions: 'Reply with exactly: GAMMA_OK',
      });

      const swarm = new Swarm(cogitator, {
        name: 'rr-distribute-test',
        strategy: 'round-robin',
        agents: [agentA, agentB, agentC],
      });

      const assignedAgents = new Set<string>();

      for (let i = 0; i < 3; i++) {
        const result = await swarm.run({ input: 'Go', saveHistory: false });

        expect(typeof result.output).toBe('string');
        expect(String(result.output).length).toBeGreaterThan(0);
        expect(result.agentResults.size).toBe(1);

        for (const name of result.agentResults.keys()) {
          assignedAgents.add(name);
        }
      }

      expect(assignedAgents.size).toBe(3);
      expect(assignedAgents).toContain('alpha');
      expect(assignedAgents).toContain('beta');
      expect(assignedAgents).toContain('gamma');
    }
  );

  it('pipeline passes output from stage to stage', { timeout: 120_000 }, async () => {
    const stage1 = createTestAgent({
      name: 'stage1-agent',
      instructions: 'Reply briefly to whatever you receive.',
    });
    const stage2 = createTestAgent({
      name: 'stage2-agent',
      instructions: 'Reply briefly to whatever you receive.',
    });

    const swarm = new Swarm(cogitator, {
      name: 'pipeline-stages-test',
      strategy: 'pipeline',
      pipeline: {
        stages: [
          { name: 'stage1', agent: stage1 },
          { name: 'stage2', agent: stage2 },
        ],
      },
    });

    const stageEvents: string[] = [];
    swarm.on('pipeline:stage', (ev) => {
      const data = ev.data as { name: string };
      stageEvents.push(data.name);
    });

    const result = await swarm.run({ input: 'hello', saveHistory: false });

    expect(result.agentResults.size).toBe(2);
    expect(result.agentResults.has('stage1')).toBe(true);
    expect(result.agentResults.has('stage2')).toBe(true);

    const stage1Output = String(result.agentResults.get('stage1')!.output);
    const stage2Output = String(result.agentResults.get('stage2')!.output);
    expect(stage1Output.length).toBeGreaterThan(0);
    expect(stage2Output.length).toBeGreaterThan(0);

    expect(result.pipelineOutputs).toBeDefined();
    expect(result.pipelineOutputs!.size).toBe(2);
    expect(result.pipelineOutputs!.get('stage1')).toBe(stage1Output);
    expect(result.pipelineOutputs!.get('stage2')).toBe(stage2Output);
    expect(String(result.output)).toBe(stage2Output);

    expect(stageEvents).toEqual(['stage1', 'stage2']);
  });

  it(
    'pipeline agents receive previous stage output (tool chain)',
    { timeout: 120_000 },
    async () => {
      const { multiply } = createTestTools();

      const mathAgent = createTestAgent({
        name: 'math-agent',
        instructions: 'Use the multiply tool to compute 5 * 6. Report the numeric result.',
        tools: [multiply],
        maxIterations: 3,
      });
      const summarizer = createTestAgent({
        name: 'summarizer-agent',
        instructions:
          'You receive some text. Summarize it in one sentence. Always include the word SUMMARIZED.',
      });

      const swarm = new Swarm(cogitator, {
        name: 'pipeline-tool-chain-test',
        strategy: 'pipeline',
        pipeline: {
          stages: [
            { name: 'compute', agent: mathAgent },
            { name: 'summarize', agent: summarizer },
          ],
        },
      });

      const result = await swarm.run({ input: 'Multiply 5 times 6', saveHistory: false });

      expect(result.agentResults.size).toBe(2);
      expect(result.agentResults.has('compute')).toBe(true);
      expect(result.agentResults.has('summarize')).toBe(true);

      const computeResult = result.agentResults.get('compute')!;
      expect(computeResult.toolCalls.length).toBeGreaterThan(0);
      expect(computeResult.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);

      const computeOutput = String(computeResult.output);
      expect(computeOutput).toContain('30');

      const finalOutput = String(result.output);
      expect(finalOutput.length).toBeGreaterThan(0);
    }
  );

  it('consensus strategy aggregates agent votes', { timeout: 120_000 }, async () => {
    const voter1 = createTestAgent({
      name: 'voter-1',
      instructions: 'When asked a math question, answer correctly. Format: VOTE: [answer]',
    });
    const voter2 = createTestAgent({
      name: 'voter-2',
      instructions: 'When asked a math question, answer correctly. Format: VOTE: [answer]',
    });
    const voter3 = createTestAgent({
      name: 'voter-3',
      instructions: 'When asked a math question, answer correctly. Format: VOTE: [answer]',
    });

    const swarm = new Swarm(cogitator, {
      name: 'consensus-test',
      strategy: 'consensus',
      agents: [voter1, voter2, voter3],
      consensus: {
        maxRounds: 2,
        threshold: 0.5,
        resolution: 'majority',
        onNoConsensus: 'escalate',
      },
    });

    const result = await swarm.run({ input: 'What is 2+2?', saveHistory: false });
    const output = String(result.output);

    expect(output.length).toBeGreaterThan(0);
    expect(result.agentResults.size).toBeGreaterThanOrEqual(3);

    expect(result.votes).toBeDefined();
    expect(result.votes!.size).toBeGreaterThanOrEqual(3);

    const hasRelevantVote = Array.from(result.votes!.values()).some((v) => {
      const vote = v as { decision: string };
      return vote.decision.includes('4');
    });
    expect(hasRelevantVote).toBe(true);
  });

  it('swarm error handling: skip failed agent', { timeout: 120_000 }, async () => {
    const badAgent = createTestAgent({
      name: 'bad-agent',
      model: 'ollama/nonexistent-model-xyz',
      instructions: 'You will never run.',
    });
    const goodAgent = createTestAgent({
      name: 'good-agent',
      instructions: 'Reply with exactly: GOOD_AGENT_OK',
    });

    const swarm = new Swarm(cogitator, {
      name: 'error-skip-test',
      strategy: 'pipeline',
      pipeline: {
        stages: [
          { name: 'failing-stage', agent: badAgent },
          { name: 'working-stage', agent: goodAgent },
        ],
      },
      errorHandling: {
        onAgentFailure: 'skip',
      },
    });

    const result = await swarm.run({ input: 'Go', saveHistory: false });

    expect(result).toBeDefined();
    expect(result.agentResults.size).toBe(2);

    const workingResult = result.agentResults.get('working-stage');
    expect(workingResult).toBeDefined();
    expect(String(workingResult!.output).length).toBeGreaterThan(0);
  });

  it('swarm events fire in correct order', { timeout: 120_000 }, async () => {
    const agent = createTestAgent({ name: 'ev-agent', instructions: 'Reply briefly.' });

    const swarm = new Swarm(cogitator, {
      name: 'events-order-test',
      strategy: 'round-robin',
      agents: [agent],
    });

    const eventLog: string[] = [];

    swarm.on('swarm:start', () => {
      eventLog.push('swarm:start');
    });
    swarm.on('agent:start', () => {
      eventLog.push('agent:start');
    });
    swarm.on('agent:complete', () => {
      eventLog.push('agent:complete');
    });
    swarm.on('swarm:complete', () => {
      eventLog.push('swarm:complete');
    });

    await swarm.run({ input: 'Hello', saveHistory: false });

    await new Promise((r) => setTimeout(r, 50));

    expect(eventLog).toContain('swarm:start');
    expect(eventLog).toContain('agent:start');
    expect(eventLog).toContain('agent:complete');
    expect(eventLog).toContain('swarm:complete');

    const iStart = eventLog.indexOf('swarm:start');
    const iAgentStart = eventLog.indexOf('agent:start');
    const iAgentComplete = eventLog.indexOf('agent:complete');
    const iComplete = eventLog.indexOf('swarm:complete');

    expect(iStart).toBeLessThan(iAgentStart);
    expect(iAgentStart).toBeLessThan(iAgentComplete);
    expect(iAgentComplete).toBeLessThan(iComplete);
  });
});
