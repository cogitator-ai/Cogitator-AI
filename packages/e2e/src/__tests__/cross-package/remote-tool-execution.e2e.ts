import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Cross-Package: Remote Tool Execution', () => {
  let cogitator: Cogitator;
  let mathServer: TestA2AServer;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const tools = createTestTools();
    const mathAgent = createTestAgent({
      name: 'math-remote',
      instructions: 'You are a math assistant. Use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    mathServer = await startTestA2AServer({
      agents: { 'math-remote': mathAgent },
      cogitator,
    });
  });

  afterAll(async () => {
    await mathServer?.close();
    await cogitator?.close();
  });

  it('agent uses remote A2A agent as tool', async () => {
    const mathClient = new A2AClient(mathServer.url);
    const remoteTool = mathClient.asTool({
      name: 'ask_math_agent',
      description:
        'Ask the remote math agent to solve a math problem. Send the problem as input text.',
    });

    const orchestrator = createTestAgent({
      name: 'orchestrator',
      instructions:
        'You have access to a remote math agent. Use the ask_math_agent tool to solve math problems. Pass the problem as the input.',
      tools: [remoteTool],
    });

    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await cogitator.run(orchestrator, {
        input: 'What is 15 times 7? Use the ask_math_agent tool.',
      });
      if (result.toolCalls.length > 0) break;
    }

    expect(typeof result!.output).toBe('string');
    expect(result!.toolCalls.length).toBeGreaterThan(0);

    if (result!.output.length > 0) {
      await expectJudge(result!.output, {
        question: 'What is 15 times 7?',
        criteria: 'Answer contains 105',
      });
    }
  });

  it('handles remote agent unavailable', async () => {
    const deadClient = new A2AClient('http://localhost:99999');
    const deadTool = deadClient.asTool({
      name: 'dead_agent',
      description: 'A remote agent that is down.',
    });

    const agent = createTestAgent({
      instructions: 'Use the dead_agent tool to answer questions.',
      tools: [deadTool],
    });

    const result = await cogitator.run(agent, {
      input: 'Ask the dead agent something.',
    });

    expect(typeof result.output).toBe('string');
  });
});
