import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  functionNode,
} from '@cogitator-ai/workflows';
import {
  createTestCogitator,
  createTestAgent,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

interface AgentWorkflowState {
  input: string;
  agentOutput: string;
  processed: boolean;
  error: string;
}

const defaultState: AgentWorkflowState = {
  input: '',
  agentOutput: '',
  processed: false,
  error: '',
};

describeE2E('Workflows: Agent Nodes', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('agent node processes input and returns output', async () => {
    const agent = createTestAgent({
      name: 'MathHelper',
      instructions: 'You are a helpful math assistant. Answer briefly.',
    });

    const node = agentNode<AgentWorkflowState>(agent, {
      inputMapper: (state) => state.input,
      stateMapper: (r) => ({ agentOutput: r.output }),
    });

    const workflow = new WorkflowBuilder<AgentWorkflowState>('agent-basic')
      .initialState({ ...defaultState })
      .addNode('prepare', async (ctx) => ({
        state: { input: ctx.state.input },
      }))
      .addNode(node.name, node.fn, { after: ['prepare'] })
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow, {
      input: 'What is 2 + 2? Reply with just the number.',
    });

    expect(result.error).toBeUndefined();
    expect(typeof result.state.agentOutput).toBe('string');
    expect(result.state.agentOutput.length).toBeGreaterThan(0);

    await expectJudge(result.state.agentOutput, {
      question: 'What is 2 + 2?',
      criteria: 'Answer mentions 4',
    });
  }, 60_000);

  it('workflow chains function and agent nodes', async () => {
    const agent = createTestAgent({
      name: 'Answerer',
      instructions: 'You are a helpful assistant. Answer the question briefly.',
    });

    const formatNode = functionNode<AgentWorkflowState>(
      'format',
      async (state) => {
        return `Please answer: ${state.input}`;
      },
      {
        stateMapper: (output) => ({ input: output as string }),
      }
    );

    const answerNode = agentNode<AgentWorkflowState>(agent, {
      inputMapper: (state) => state.input,
      stateMapper: (r) => ({ agentOutput: r.output }),
    });

    const postNode = functionNode<AgentWorkflowState>(
      'postprocess',
      async () => {
        return true;
      },
      {
        stateMapper: () => ({ processed: true }),
      }
    );

    const workflow = new WorkflowBuilder<AgentWorkflowState>('agent-chain')
      .initialState({ ...defaultState })
      .addNode(formatNode.name, formatNode.fn)
      .addNode(answerNode.name, answerNode.fn, { after: [formatNode.name] })
      .addNode(postNode.name, postNode.fn, { after: [answerNode.name] })
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow, {
      input: 'What is the largest planet in our solar system?',
    });

    expect(result.error).toBeUndefined();
    expect(result.state.processed).toBe(true);
    expect(typeof result.state.agentOutput).toBe('string');
    expect(result.state.agentOutput.length).toBeGreaterThan(0);
  }, 60_000);

  it('workflow handles agent error gracefully', async () => {
    const badAgent = createTestAgent({
      name: 'BadAgent',
      model: 'ollama/nonexistent-model-xyz',
      instructions: 'You will never run.',
    });

    const node = agentNode<AgentWorkflowState>(badAgent, {
      inputMapper: (state) => state.input,
      stateMapper: (r) => ({ agentOutput: r.output }),
    });

    const workflow = new WorkflowBuilder<AgentWorkflowState>('agent-error')
      .initialState({ ...defaultState })
      .addNode(node.name, node.fn)
      .build();

    const executor = new WorkflowExecutor(cogitator);
    const result = await executor.execute(workflow, {
      input: 'This should fail',
    });

    expect(result.error).toBeDefined();
  }, 30_000);
});
