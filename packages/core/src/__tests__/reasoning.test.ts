import { describe, it, expect, vi } from 'vitest';
import {
  parseBranchResponse,
  parseEvaluationResponse,
  buildBranchGenerationPrompt,
  buildBranchEvaluationPrompt,
  buildSynthesisPrompt,
} from '../reasoning/prompts';
import { BranchGenerator } from '../reasoning/branch-generator';
import { BranchEvaluator } from '../reasoning/branch-evaluator';
import type {
  ThoughtNode,
  ThoughtBranch,
  AgentContext,
  LLMBackend,
  ChatResponse,
} from '@cogitator-ai/types';

describe('parseBranchResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify({
      branches: [
        {
          thought: 'Use calculator to compute the result',
          action: { type: 'tool_call', toolName: 'calculator', arguments: { expr: '2+2' } },
        },
        {
          thought: 'Provide direct answer',
          action: { type: 'response', content: 'The answer is 4' },
        },
      ],
    });

    const parsed = parseBranchResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.branches).toHaveLength(2);
    expect(parsed?.branches[0].thought).toBe('Use calculator to compute the result');
    expect(parsed?.branches[0].action.type).toBe('tool_call');
  });

  it('handles markdown code blocks', () => {
    const response =
      '```json\n{"branches": [{"thought": "test", "action": {"type": "response", "content": "ok"}}]}\n```';

    const parsed = parseBranchResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.branches).toHaveLength(1);
  });

  it('handles plain code blocks', () => {
    const response =
      '```\n{"branches": [{"thought": "analyze", "action": {"type": "sub_goal", "goal": "break down problem"}}]}\n```';

    const parsed = parseBranchResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.branches[0].action.type).toBe('sub_goal');
  });

  it('returns null for invalid JSON', () => {
    const response = 'Not valid JSON at all';
    const parsed = parseBranchResponse(response);
    expect(parsed).toBeNull();
  });

  it('returns null for missing branches array', () => {
    const response = JSON.stringify({ data: [] });
    const parsed = parseBranchResponse(response);
    expect(parsed).toBeNull();
  });

  it('filters invalid branches', () => {
    const response = JSON.stringify({
      branches: [
        { thought: 'valid', action: { type: 'response', content: 'ok' } },
        { thought: '', action: { type: 'response', content: 'empty thought' } },
        { action: { type: 'response', content: 'no thought' } },
        { thought: 'no action' },
        { thought: 'invalid action type', action: { type: 'invalid' } },
        null,
        'not an object',
      ],
    });

    const parsed = parseBranchResponse(response);
    expect(parsed?.branches).toHaveLength(1);
    expect(parsed?.branches[0].thought).toBe('valid');
  });
});

describe('parseEvaluationResponse', () => {
  it('parses valid evaluation response', () => {
    const response = JSON.stringify({
      confidence: 0.85,
      progress: 0.4,
      novelty: 0.7,
      reasoning: 'This approach is promising',
    });

    const parsed = parseEvaluationResponse(response);
    expect(parsed).not.toBeNull();
    expect(parsed?.confidence).toBe(0.85);
    expect(parsed?.progress).toBe(0.4);
    expect(parsed?.novelty).toBe(0.7);
    expect(parsed?.reasoning).toBe('This approach is promising');
  });

  it('handles markdown code blocks', () => {
    const response =
      '```json\n{"confidence": 0.9, "progress": 0.5, "novelty": 0.6, "reasoning": "good"}\n```';

    const parsed = parseEvaluationResponse(response);
    expect(parsed?.confidence).toBe(0.9);
  });

  it('clamps values to valid range', () => {
    const response = JSON.stringify({
      confidence: 1.5,
      progress: -0.3,
      novelty: 2.0,
      reasoning: 'test',
    });

    const parsed = parseEvaluationResponse(response);
    expect(parsed?.confidence).toBe(1);
    expect(parsed?.progress).toBe(0);
    expect(parsed?.novelty).toBe(1);
  });

  it('provides defaults for missing numeric fields', () => {
    const response = JSON.stringify({
      reasoning: 'minimal response',
    });

    const parsed = parseEvaluationResponse(response);
    expect(parsed?.confidence).toBe(0.5);
    expect(parsed?.progress).toBe(0.3);
    expect(parsed?.novelty).toBe(0.5);
  });

  it('provides empty string for missing reasoning', () => {
    const response = JSON.stringify({
      confidence: 0.8,
      progress: 0.5,
      novelty: 0.6,
    });

    const parsed = parseEvaluationResponse(response);
    expect(parsed?.reasoning).toBe('');
  });

  it('returns null for invalid JSON', () => {
    const response = 'garbage';
    const parsed = parseEvaluationResponse(response);
    expect(parsed).toBeNull();
  });
});

describe('Reasoning Prompts', () => {
  const createNode = (): ThoughtNode => ({
    id: 'node_1',
    parentId: null,
    depth: 1,
    branch: {
      id: 'branch_1',
      parentId: null,
      thought: 'Calculate the first part',
      proposedAction: { type: 'tool_call', toolName: 'calculator', arguments: { expr: '10*5' } },
      messagesSnapshot: [],
    },
    messages: [],
    status: 'completed',
    cumulativeScore: 0.7,
    children: [],
    createdAt: Date.now(),
    result: { response: '50' },
  });

  describe('buildBranchGenerationPrompt', () => {
    it('includes goal in prompt', () => {
      const prompt = buildBranchGenerationPrompt(
        'Solve equation x^2 = 4',
        null,
        ['calculator'],
        3,
        []
      );

      expect(prompt).toContain('Solve equation x^2 = 4');
      expect(prompt).toContain('calculator');
      expect(prompt).toContain('3');
    });

    it('includes current state from node', () => {
      const node = createNode();
      const prompt = buildBranchGenerationPrompt('Solve problem', node, ['calculator'], 2, []);

      expect(prompt).toContain('Calculate the first part');
      expect(prompt).toContain('50');
      expect(prompt).toContain('Depth: 1');
    });

    it('includes explored thoughts to avoid', () => {
      const explored = ['Already tried approach A', 'Already tried approach B'];
      const prompt = buildBranchGenerationPrompt('Goal', null, [], 2, explored);

      expect(prompt).toContain('ALREADY EXPLORED');
      expect(prompt).toContain('Already tried approach A');
      expect(prompt).toContain('Already tried approach B');
    });

    it('shows starting fresh for null node', () => {
      const prompt = buildBranchGenerationPrompt('Goal', null, ['tool1'], 2, []);

      expect(prompt).toContain('Starting fresh');
    });
  });

  describe('buildBranchEvaluationPrompt', () => {
    it('includes branch details', () => {
      const branch: ThoughtBranch = {
        id: 'b1',
        parentId: null,
        thought: 'Use systematic approach',
        proposedAction: { type: 'tool_call', toolName: 'analyzer', arguments: {} },
        messagesSnapshot: [],
      };

      const prompt = buildBranchEvaluationPrompt(branch, 'Analyze data', []);

      expect(prompt).toContain('Use systematic approach');
      expect(prompt).toContain('analyzer');
      expect(prompt).toContain('Analyze data');
      expect(prompt).toContain('CONFIDENCE');
      expect(prompt).toContain('PROGRESS');
      expect(prompt).toContain('NOVELTY');
    });

    it('includes sibling approaches', () => {
      const branch: ThoughtBranch = {
        id: 'b1',
        parentId: null,
        thought: 'Main approach',
        proposedAction: { type: 'response', content: 'answer' },
        messagesSnapshot: [],
      };

      const siblings: ThoughtBranch[] = [
        {
          id: 'b2',
          parentId: null,
          thought: 'Alternative approach 1',
          proposedAction: { type: 'response', content: 'alt1' },
          messagesSnapshot: [],
        },
        {
          id: 'b3',
          parentId: null,
          thought: 'Alternative approach 2',
          proposedAction: { type: 'sub_goal', goal: 'sub' },
          messagesSnapshot: [],
        },
      ];

      const prompt = buildBranchEvaluationPrompt(branch, 'Goal', siblings);

      expect(prompt).toContain('OTHER APPROACHES');
      expect(prompt).toContain('Alternative approach 1');
      expect(prompt).toContain('Alternative approach 2');
    });
  });

  describe('buildSynthesisPrompt', () => {
    it('builds synthesis from path', () => {
      const path: ThoughtNode[] = [
        {
          ...createNode(),
          id: 'n1',
          branch: {
            ...createNode().branch,
            thought: 'First calculate base value',
          },
          result: { response: 'Base value is 10' },
        },
        {
          ...createNode(),
          id: 'n2',
          branch: {
            ...createNode().branch,
            thought: 'Then apply formula',
          },
          result: { response: 'Result is 42' },
        },
      ];

      const prompt = buildSynthesisPrompt('Calculate final answer', path);

      expect(prompt).toContain('Calculate final answer');
      expect(prompt).toContain('Step 1');
      expect(prompt).toContain('Step 2');
      expect(prompt).toContain('First calculate base value');
      expect(prompt).toContain('Then apply formula');
      expect(prompt).toContain('Base value is 10');
      expect(prompt).toContain('Result is 42');
    });
  });
});

describe('BranchGenerator', () => {
  const createMockLLM = (response: string): LLMBackend => ({
    chat: vi.fn().mockResolvedValue({ content: response } as ChatResponse),
    stream: vi.fn(),
    listModels: vi.fn(),
    healthCheck: vi.fn(),
    countTokens: vi.fn(),
    validateModel: vi.fn(),
    config: {} as never,
  });

  it('generates branches from LLM response', async () => {
    const mockResponse = JSON.stringify({
      branches: [
        { thought: 'Approach A', action: { type: 'response', content: 'Answer A' } },
        { thought: 'Approach B', action: { type: 'tool_call', toolName: 'calc', arguments: {} } },
      ],
    });

    const llm = createMockLLM(mockResponse);
    const generator = new BranchGenerator(llm, 'gpt-4');

    const context: AgentContext = {
      agentId: 'a1',
      agentName: 'Test',
      runId: 'r1',
      threadId: 't1',
      goal: 'Test goal',
      iterationIndex: 0,
      previousActions: [],
      availableTools: ['calc'],
    };

    const branches = await generator.generate(null, 'Test goal', 2, context, []);

    expect(branches).toHaveLength(2);
    expect(branches[0].thought).toBe('Approach A');
    expect(branches[1].thought).toBe('Approach B');
    expect(branches[0].id).toBeDefined();
    expect(branches[0].parentId).toBeNull();
  });

  it('limits branches to requested count', async () => {
    const mockResponse = JSON.stringify({
      branches: [
        { thought: 'A', action: { type: 'response', content: '1' } },
        { thought: 'B', action: { type: 'response', content: '2' } },
        { thought: 'C', action: { type: 'response', content: '3' } },
        { thought: 'D', action: { type: 'response', content: '4' } },
      ],
    });

    const llm = createMockLLM(mockResponse);
    const generator = new BranchGenerator(llm, 'gpt-4');

    const context: AgentContext = {
      agentId: 'a1',
      agentName: 'Test',
      runId: 'r1',
      threadId: 't1',
      goal: 'Goal',
      iterationIndex: 0,
      previousActions: [],
      availableTools: [],
    };

    const branches = await generator.generate(null, 'Goal', 2, context, []);

    expect(branches).toHaveLength(2);
  });

  it('creates fallback branch on parse failure', async () => {
    const llm = createMockLLM('invalid json');
    const generator = new BranchGenerator(llm, 'gpt-4');

    const context: AgentContext = {
      agentId: 'a1',
      agentName: 'Test',
      runId: 'r1',
      threadId: 't1',
      goal: 'Fallback goal',
      iterationIndex: 0,
      previousActions: [],
      availableTools: [],
    };

    const branches = await generator.generate(null, 'Fallback goal', 3, context, []);

    expect(branches).toHaveLength(1);
    expect(branches[0].thought).toContain('Fallback goal');
    expect(branches[0].proposedAction.type).toBe('response');
  });

  it('preserves parent id from current node', async () => {
    const mockResponse = JSON.stringify({
      branches: [{ thought: 'Child branch', action: { type: 'response', content: 'ok' } }],
    });

    const llm = createMockLLM(mockResponse);
    const generator = new BranchGenerator(llm, 'gpt-4');

    const parentNode: ThoughtNode = {
      id: 'parent_node_123',
      parentId: null,
      depth: 1,
      branch: {
        id: 'parent_branch',
        parentId: null,
        thought: 'Parent thought',
        proposedAction: { type: 'response', content: 'parent' },
        messagesSnapshot: [],
      },
      messages: [{ role: 'user', content: 'test' }],
      status: 'completed',
      cumulativeScore: 0.5,
      children: [],
      createdAt: Date.now(),
    };

    const context: AgentContext = {
      agentId: 'a1',
      agentName: 'Test',
      runId: 'r1',
      threadId: 't1',
      goal: 'Goal',
      iterationIndex: 0,
      previousActions: [],
      availableTools: [],
    };

    const branches = await generator.generate(parentNode, 'Goal', 1, context, []);

    expect(branches[0].parentId).toBe('parent_node_123');
    expect(branches[0].messagesSnapshot).toHaveLength(1);
  });
});

describe('BranchEvaluator', () => {
  const createMockLLM = (response: string): LLMBackend => ({
    chat: vi.fn().mockResolvedValue({ content: response } as ChatResponse),
    stream: vi.fn(),
    listModels: vi.fn(),
    healthCheck: vi.fn(),
    countTokens: vi.fn(),
    validateModel: vi.fn(),
    config: {} as never,
  });

  const createContext = (): AgentContext => ({
    agentId: 'a1',
    agentName: 'Test',
    runId: 'r1',
    threadId: 't1',
    goal: 'Evaluate branches',
    iterationIndex: 0,
    previousActions: [],
    availableTools: ['calc'],
  });

  const createBranch = (overrides: Partial<ThoughtBranch> = {}): ThoughtBranch => ({
    id: 'branch_1',
    parentId: null,
    thought: 'Test thought',
    proposedAction: { type: 'response', content: 'answer' },
    messagesSnapshot: [],
    ...overrides,
  });

  it('evaluates branch with LLM', async () => {
    const mockResponse = JSON.stringify({
      confidence: 0.8,
      progress: 0.5,
      novelty: 0.7,
      reasoning: 'Good approach',
    });

    const llm = createMockLLM(mockResponse);
    const evaluator = new BranchEvaluator({ llm, model: 'gpt-4' });

    const score = await evaluator.evaluate(createBranch(), 'Test goal', createContext(), []);

    expect(score.confidence).toBe(0.8);
    expect(score.progress).toBe(0.5);
    expect(score.novelty).toBe(0.7);
    expect(score.reasoning).toBe('Good approach');
    expect(score.composite).toBeGreaterThan(0);
  });

  it('calculates composite score with weights', async () => {
    const mockResponse = JSON.stringify({
      confidence: 1.0,
      progress: 1.0,
      novelty: 1.0,
      reasoning: 'Perfect',
    });

    const llm = createMockLLM(mockResponse);
    const evaluator = new BranchEvaluator({
      llm,
      model: 'gpt-4',
      confidenceWeight: 0.5,
      progressWeight: 0.3,
      noveltyWeight: 0.2,
    });

    const score = await evaluator.evaluate(createBranch(), 'Goal', createContext(), []);

    expect(score.composite).toBeCloseTo(1.0);
  });

  it('creates fallback score on parse failure', async () => {
    const llm = createMockLLM('invalid');
    const evaluator = new BranchEvaluator({ llm, model: 'gpt-4' });

    const score = await evaluator.evaluate(createBranch(), 'Goal', createContext(), []);

    expect(score.confidence).toBe(0.5);
    expect(score.progress).toBe(0.3);
    expect(score.reasoning).toContain('Fallback');
  });

  it('evaluates batch of branches', async () => {
    let callCount = 0;
    const llm: LLMBackend = {
      chat: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          content: JSON.stringify({
            confidence: 0.5 + callCount * 0.1,
            progress: 0.5,
            novelty: 0.5,
            reasoning: `Response ${callCount}`,
          }),
        } as ChatResponse);
      }),
      stream: vi.fn(),
      listModels: vi.fn(),
      healthCheck: vi.fn(),
      countTokens: vi.fn(),
      validateModel: vi.fn(),
      config: {} as never,
    };

    const evaluator = new BranchEvaluator({ llm, model: 'gpt-4' });

    const branches = [
      createBranch({ id: 'b1' }),
      createBranch({ id: 'b2' }),
      createBranch({ id: 'b3' }),
    ];

    const results = await evaluator.evaluateBatch(branches, 'Goal', createContext());

    expect(results.size).toBe(3);
    expect(results.get('b1')).toBeDefined();
    expect(results.get('b2')).toBeDefined();
    expect(results.get('b3')).toBeDefined();
  });

  it('calculates novelty based on siblings', async () => {
    const mockResponse = JSON.stringify({
      confidence: 0.7,
      progress: 0.5,
      novelty: 0.8,
      reasoning: 'Evaluated',
    });

    const llm = createMockLLM(mockResponse);
    const evaluator = new BranchEvaluator({ llm, model: 'gpt-4' });

    const mainBranch = createBranch({
      id: 'main',
      thought: 'Unique approach using machine learning',
      proposedAction: { type: 'tool_call', toolName: 'ml_tool', arguments: {} },
    });

    const siblings = [
      createBranch({
        id: 's1',
        thought: 'Similar approach using machine learning',
        proposedAction: { type: 'tool_call', toolName: 'ml_tool', arguments: {} },
      }),
      createBranch({
        id: 's2',
        thought: 'Different statistical method',
        proposedAction: { type: 'tool_call', toolName: 'stats_tool', arguments: {} },
      }),
    ];

    const score = await evaluator.evaluate(mainBranch, 'Analyze data', createContext(), siblings);

    expect(score).toBeDefined();
    expect(score.composite).toBeGreaterThan(0);
  });
});
