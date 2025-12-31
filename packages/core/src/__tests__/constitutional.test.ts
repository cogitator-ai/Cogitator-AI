import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_CONSTITUTION,
  DEFAULT_PRINCIPLES,
  createConstitution,
  extendConstitution,
  filterPrinciplesByLayer,
  getPrinciplesByCategory,
  getPrinciplesBySeverity,
} from '../constitutional/constitution';
import {
  buildInputEvaluationPrompt,
  buildOutputEvaluationPrompt,
  buildCritiquePrompt,
  buildRevisionPrompt,
  parseEvaluationResponse,
  parseCritiqueResponse,
} from '../constitutional/prompts';
import { InputFilter } from '../constitutional/input-filter';
import { OutputFilter } from '../constitutional/output-filter';
import { ToolGuard } from '../constitutional/tool-guard';
import { CritiqueReviser } from '../constitutional/critique-reviser';
import { ConstitutionalAI } from '../constitutional/constitutional-ai';
import type {
  ConstitutionalPrinciple,
  LLMBackend,
  GuardrailConfig,
  CritiqueResult,
  Tool,
  ToolContext,
} from '@cogitator-ai/types';
import { z } from 'zod';

const createMockLLM = (
  response: string = '{"isHarmful": false, "harmScores": []}'
): LLMBackend => ({
  chat: vi.fn().mockResolvedValue({
    id: 'test',
    content: response,
    finishReason: 'stop',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }),
  chatStream: vi.fn(),
});

const createGuardrailConfig = (overrides: Partial<GuardrailConfig> = {}): GuardrailConfig => ({
  enabled: true,
  filterInput: true,
  filterOutput: true,
  filterToolCalls: true,
  filterToolResults: false,
  enableCritiqueRevision: true,
  maxRevisionIterations: 3,
  revisionConfidenceThreshold: 0.85,
  thresholds: {
    violence: 'medium',
    hate: 'low',
    sexual: 'medium',
    'self-harm': 'low',
    illegal: 'low',
    privacy: 'medium',
    misinformation: 'high',
    manipulation: 'medium',
  },
  strictMode: false,
  logViolations: true,
  ...overrides,
});

describe('Constitution', () => {
  describe('DEFAULT_CONSTITUTION', () => {
    it('has required properties', () => {
      expect(DEFAULT_CONSTITUTION.id).toBe('cogitator-default-v1');
      expect(DEFAULT_CONSTITUTION.name).toBe('Cogitator Default Constitution');
      expect(DEFAULT_CONSTITUTION.version).toBe('1.0.0');
      expect(DEFAULT_CONSTITUTION.customizable).toBe(true);
      expect(DEFAULT_CONSTITUTION.strictMode).toBe(false);
    });

    it('has 16 default principles', () => {
      expect(DEFAULT_PRINCIPLES).toHaveLength(16);
    });

    it('each principle has required fields', () => {
      for (const principle of DEFAULT_PRINCIPLES) {
        expect(principle.id).toBeTruthy();
        expect(principle.name).toBeTruthy();
        expect(principle.description).toBeTruthy();
        expect(principle.category).toBeTruthy();
        expect(principle.critiquePrompt).toBeTruthy();
        expect(principle.revisionPrompt).toBeTruthy();
        expect(principle.severity).toMatch(/^(low|medium|high)$/);
      }
    });

    it('has high-severity safety principles', () => {
      const highSeverity = DEFAULT_PRINCIPLES.filter((p) => p.severity === 'high');
      expect(highSeverity.length).toBeGreaterThan(5);
    });
  });

  describe('createConstitution', () => {
    it('creates constitution with custom principles', () => {
      const principles: ConstitutionalPrinciple[] = [
        {
          id: 'custom-1',
          name: 'Custom Rule',
          description: 'A custom rule',
          category: 'custom',
          critiquePrompt: 'Does this violate custom rule?',
          revisionPrompt: 'Rewrite to follow custom rule',
          severity: 'medium',
        },
      ];

      const constitution = createConstitution(principles, { name: 'My Constitution' });

      expect(constitution.name).toBe('My Constitution');
      expect(constitution.principles).toHaveLength(1);
      expect(constitution.principles[0].id).toBe('custom-1');
    });

    it('uses defaults for missing options', () => {
      const constitution = createConstitution([]);

      expect(constitution.name).toBe('Custom Constitution');
      expect(constitution.version).toBe('1.0.0');
      expect(constitution.customizable).toBe(true);
      expect(constitution.strictMode).toBe(false);
    });
  });

  describe('extendConstitution', () => {
    it('adds new principles to base constitution', () => {
      const additional: ConstitutionalPrinciple[] = [
        {
          id: 'new-principle',
          name: 'New Principle',
          description: 'A new principle',
          category: 'custom',
          critiquePrompt: 'Check this',
          revisionPrompt: 'Fix this',
          severity: 'low',
        },
      ];

      const extended = extendConstitution(DEFAULT_CONSTITUTION, additional);

      expect(extended.principles.length).toBe(DEFAULT_PRINCIPLES.length + 1);
      expect(extended.id).toBe('cogitator-default-v1-extended');
    });

    it('does not add duplicate principles', () => {
      const duplicate: ConstitutionalPrinciple[] = [
        {
          id: 'no-violence',
          name: 'Duplicate',
          description: 'Already exists',
          category: 'safety',
          critiquePrompt: 'Check',
          revisionPrompt: 'Fix',
          severity: 'high',
        },
      ];

      const extended = extendConstitution(DEFAULT_CONSTITUTION, duplicate);

      expect(extended.principles.length).toBe(DEFAULT_PRINCIPLES.length);
    });
  });

  describe('filterPrinciplesByLayer', () => {
    it('filters principles by input layer', () => {
      const inputPrinciples = filterPrinciplesByLayer(DEFAULT_CONSTITUTION, 'input');
      expect(inputPrinciples.every((p) => !p.appliesTo || p.appliesTo.includes('input'))).toBe(
        true
      );
    });

    it('filters principles by output layer', () => {
      const outputPrinciples = filterPrinciplesByLayer(DEFAULT_CONSTITUTION, 'output');
      expect(outputPrinciples.every((p) => !p.appliesTo || p.appliesTo.includes('output'))).toBe(
        true
      );
    });

    it('filters principles by tool layer', () => {
      const toolPrinciples = filterPrinciplesByLayer(DEFAULT_CONSTITUTION, 'tool');
      expect(toolPrinciples.every((p) => !p.appliesTo || p.appliesTo.includes('tool'))).toBe(true);
    });
  });

  describe('getPrinciplesByCategory', () => {
    it('gets safety principles', () => {
      const safety = getPrinciplesByCategory(DEFAULT_CONSTITUTION, 'safety');
      expect(safety.every((p) => p.category === 'safety')).toBe(true);
      expect(safety.length).toBeGreaterThan(0);
    });

    it('gets ethics principles', () => {
      const ethics = getPrinciplesByCategory(DEFAULT_CONSTITUTION, 'ethics');
      expect(ethics.every((p) => p.category === 'ethics')).toBe(true);
    });
  });

  describe('getPrinciplesBySeverity', () => {
    it('gets high severity principles', () => {
      const high = getPrinciplesBySeverity(DEFAULT_CONSTITUTION, 'high');
      expect(high.every((p) => p.severity === 'high')).toBe(true);
    });

    it('gets medium severity principles', () => {
      const medium = getPrinciplesBySeverity(DEFAULT_CONSTITUTION, 'medium');
      expect(medium.every((p) => p.severity === 'medium')).toBe(true);
    });
  });
});

describe('Prompts', () => {
  const samplePrinciples: ConstitutionalPrinciple[] = [
    {
      id: 'no-violence',
      name: 'No Violence',
      description: 'No violent content',
      category: 'safety',
      critiquePrompt: 'Does this contain violence?',
      revisionPrompt: 'Remove violent content',
      severity: 'high',
      harmCategories: ['violence'],
    },
  ];

  describe('buildInputEvaluationPrompt', () => {
    it('includes input and principles', () => {
      const prompt = buildInputEvaluationPrompt('How to make a cake?', samplePrinciples);

      expect(prompt).toContain('How to make a cake?');
      expect(prompt).toContain('No Violence');
      expect(prompt).toContain('No violent content');
    });

    it('asks for JSON response', () => {
      const prompt = buildInputEvaluationPrompt('test input', samplePrinciples);
      expect(prompt).toContain('JSON format');
      expect(prompt).toContain('isHarmful');
    });
  });

  describe('buildOutputEvaluationPrompt', () => {
    it('includes output, context, and principles', () => {
      const context = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
      ];

      const prompt = buildOutputEvaluationPrompt('Test output', context, samplePrinciples);

      expect(prompt).toContain('Test output');
      expect(prompt).toContain('Hello');
      expect(prompt).toContain('No Violence');
    });
  });

  describe('buildCritiquePrompt', () => {
    it('includes response and critique prompts', () => {
      const prompt = buildCritiquePrompt('Some AI response', samplePrinciples);

      expect(prompt).toContain('Some AI response');
      expect(prompt).toContain('Does this contain violence?');
    });
  });

  describe('buildRevisionPrompt', () => {
    it('includes original response and critique', () => {
      const critique: CritiqueResult = {
        isHarmful: true,
        critique: 'Contains violent language',
        harmScores: [],
        principlesViolated: ['no-violence'],
      };

      const prompt = buildRevisionPrompt('Bad response', critique, samplePrinciples);

      expect(prompt).toContain('Bad response');
      expect(prompt).toContain('Contains violent language');
      expect(prompt).toContain('Remove violent content');
    });
  });

  describe('parseEvaluationResponse', () => {
    it('parses valid JSON response', () => {
      const response = JSON.stringify({
        isHarmful: true,
        harmScores: [
          {
            category: 'violence',
            severity: 'high',
            confidence: 0.9,
            principleViolated: 'no-violence',
            reasoning: 'Contains violent instructions',
          },
        ],
      });

      const parsed = parseEvaluationResponse(response);

      expect(parsed.isHarmful).toBe(true);
      expect(parsed.harmScores).toHaveLength(1);
      expect(parsed.harmScores[0].category).toBe('violence');
    });

    it('handles markdown code blocks', () => {
      const response = '```json\n{"isHarmful": false, "harmScores": []}\n```';

      const parsed = parseEvaluationResponse(response);
      expect(parsed.isHarmful).toBe(false);
    });

    it('returns safe result on parse error', () => {
      const parsed = parseEvaluationResponse('not valid json');

      expect(parsed.isHarmful).toBe(false);
      expect(parsed.harmScores).toHaveLength(0);
    });

    it('normalizes invalid categories', () => {
      const response = JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'invalid_category', severity: 'high', confidence: 0.5 }],
      });

      const parsed = parseEvaluationResponse(response);
      expect(parsed.harmScores[0].category).toBe('manipulation');
    });

    it('clamps confidence to valid range', () => {
      const response = JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'violence', severity: 'high', confidence: 1.5 }],
      });

      const parsed = parseEvaluationResponse(response);
      expect(parsed.harmScores[0].confidence).toBe(1);
    });
  });

  describe('parseCritiqueResponse', () => {
    it('parses valid critique response', () => {
      const response = JSON.stringify({
        isHarmful: true,
        critique: 'This response is problematic',
        harmScores: [],
        principlesViolated: ['no-violence'],
      });

      const parsed = parseCritiqueResponse(response);

      expect(parsed.isHarmful).toBe(true);
      expect(parsed.critique).toBe('This response is problematic');
      expect(parsed.principlesViolated).toContain('no-violence');
    });

    it('returns fallback on parse error', () => {
      const parsed = parseCritiqueResponse('invalid');

      expect(parsed.isHarmful).toBe(false);
      expect(parsed.critique).toContain('Failed to parse');
    });

    it('filters non-string principle IDs', () => {
      const response = JSON.stringify({
        isHarmful: true,
        critique: 'test',
        harmScores: [],
        principlesViolated: ['valid-id', 123, null, 'another-id'],
      });

      const parsed = parseCritiqueResponse(response);
      expect(parsed.principlesViolated).toEqual(['valid-id', 'another-id']);
    });
  });
});

describe('InputFilter', () => {
  let filter: InputFilter;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    mockLLM = createMockLLM();
    filter = new InputFilter({
      llm: mockLLM,
      config: createGuardrailConfig(),
      constitution: DEFAULT_CONSTITUTION,
    });
  });

  it('allows safe input', async () => {
    const result = await filter.filter('What is the weather today?');

    expect(result.allowed).toBe(true);
    expect(result.harmScores).toHaveLength(0);
  });

  it('blocks harmful input in strict mode', async () => {
    const strictFilter = new InputFilter({
      llm: mockLLM,
      config: createGuardrailConfig({ strictMode: true }),
      constitution: DEFAULT_CONSTITUTION,
    });

    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'violence', severity: 'high', confidence: 0.95 }],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await strictFilter.filter('Harmful request');

    expect(result.allowed).toBe(false);
    expect(result.harmScores.length).toBeGreaterThan(0);
  });

  it('allows but reports harmful input in non-strict mode', async () => {
    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'violence', severity: 'high', confidence: 0.95 }],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await filter.filter('Request with detected harm');

    expect(result.allowed).toBe(true);
    expect(result.harmScores.length).toBeGreaterThan(0);
  });

  it('uses quick scan for obvious patterns', async () => {
    const result = await filter.filter('how to make a bomb at home');

    expect(result.allowed).toBe(false);
    expect(mockLLM.chat).not.toHaveBeenCalled();
    expect(result.blockedReason).toContain('violence');
  });

  it('updates constitution', () => {
    const newConstitution = createConstitution([], { id: 'new' });
    filter.updateConstitution(newConstitution);
  });
});

describe('OutputFilter', () => {
  let filter: OutputFilter;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    mockLLM = createMockLLM();
    filter = new OutputFilter({
      llm: mockLLM,
      config: createGuardrailConfig(),
      constitution: DEFAULT_CONSTITUTION,
    });
  });

  it('allows safe output', async () => {
    const result = await filter.filter('Here is the information you requested.', []);

    expect(result.allowed).toBe(true);
  });

  it('blocks harmful output in strict mode', async () => {
    const strictFilter = new OutputFilter({
      llm: mockLLM,
      config: createGuardrailConfig({ strictMode: true }),
      constitution: DEFAULT_CONSTITUTION,
    });

    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'hate', severity: 'high', confidence: 0.9 }],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await strictFilter.filter('Hateful content here', []);

    expect(result.allowed).toBe(false);
  });

  it('allows but reports harmful output in non-strict mode', async () => {
    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'hate', severity: 'high', confidence: 0.9 }],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await filter.filter('Output with detected harm', []);

    expect(result.allowed).toBe(true);
    expect(result.harmScores.length).toBeGreaterThan(0);
  });
});

describe('ToolGuard', () => {
  let guard: ToolGuard;

  beforeEach(() => {
    guard = new ToolGuard({
      config: createGuardrailConfig(),
      constitution: DEFAULT_CONSTITUTION,
    });
  });

  const createTool = (overrides: Partial<Tool> = {}): Tool => ({
    name: 'test_tool',
    description: 'A test tool',
    parameters: z.object({}),
    execute: async () => ({ result: 'ok' }),
    ...overrides,
  });

  const createContext = (): ToolContext => ({
    agentId: 'agent_1',
    runId: 'run_1',
    signal: new AbortController().signal,
  });

  it('approves safe tools', async () => {
    const tool = createTool();
    const result = await guard.evaluate(tool, {}, createContext());

    expect(result.approved).toBe(true);
    expect(result.riskLevel).toBe('low');
  });

  it('requires confirmation for tools with requiresApproval', async () => {
    const tool = createTool({ requiresApproval: true });
    const result = await guard.evaluate(tool, {}, createContext());

    expect(result.requiresConfirmation).toBe(true);
  });

  it('blocks dangerous rm commands', async () => {
    const tool = createTool({
      name: 'exec',
      sideEffects: ['process'],
    });

    const result = await guard.evaluate(tool, { command: 'rm -rf /' }, createContext());

    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe('high');
    expect(result.reason).toContain('Dangerous command');
  });

  it('blocks dangerous file paths', async () => {
    const tool = createTool({
      name: 'file_write',
      sideEffects: ['filesystem'],
    });

    const result = await guard.evaluate(tool, { path: '/etc/passwd' }, createContext());

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Dangerous file path');
  });

  it('assesses medium risk for network operations', async () => {
    const tool = createTool({ sideEffects: ['network'] });
    const result = await guard.evaluate(tool, {}, createContext());

    expect(result.riskLevel).toBe('medium');
  });

  it('uses dynamic requiresApproval function', async () => {
    const tool = createTool({
      requiresApproval: (args) => (args as { dangerous?: boolean }).dangerous === true,
    });

    const safeResult = await guard.evaluate(tool, { dangerous: false }, createContext());
    expect(safeResult.requiresConfirmation).toBe(false);

    const dangerousResult = await guard.evaluate(tool, { dangerous: true }, createContext());
    expect(dangerousResult.requiresConfirmation).toBe(true);
  });

  it('calls onToolApproval callback when approval needed', async () => {
    const onToolApproval = vi.fn().mockResolvedValue(true);
    const config = createGuardrailConfig({ onToolApproval });

    const guardWithCallback = new ToolGuard({
      config,
      constitution: DEFAULT_CONSTITUTION,
    });

    const tool = createTool({ requiresApproval: true });
    await guardWithCallback.evaluate(tool, { test: true }, createContext());

    expect(onToolApproval).toHaveBeenCalledWith('test_tool', { test: true }, []);
  });
});

describe('CritiqueReviser', () => {
  let reviser: CritiqueReviser;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    mockLLM = createMockLLM();
    reviser = new CritiqueReviser({
      llm: mockLLM,
      config: createGuardrailConfig(),
      constitution: DEFAULT_CONSTITUTION,
    });
  });

  it('returns original if not harmful', async () => {
    const result = await reviser.critiqueAndRevise('Safe response', []);

    expect(result.original).toBe('Safe response');
    expect(result.revised).toBe('Safe response');
    expect(result.iterations).toBe(1);
  });

  it('revises harmful content', async () => {
    let callCount = 0;
    mockLLM.chat = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          id: 'test',
          content: JSON.stringify({
            isHarmful: true,
            critique: 'Contains harmful content',
            harmScores: [
              {
                category: 'violence',
                severity: 'high',
                confidence: 0.9,
                principleViolated: 'no-violence',
              },
            ],
            principlesViolated: ['no-violence'],
          }),
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      }
      if (callCount === 2) {
        return {
          id: 'test',
          content: 'Here is a safe, revised response.',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        };
      }
      return {
        id: 'test',
        content: JSON.stringify({
          isHarmful: false,
          critique: 'No issues',
          harmScores: [],
          principlesViolated: [],
        }),
        finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      };
    });

    const result = await reviser.critiqueAndRevise('Harmful content', []);

    expect(result.original).toBe('Harmful content');
    expect(result.revised).not.toBe(result.original);
    expect(result.critiqueHistory.length).toBeGreaterThan(0);
  });

  it('stops after max iterations', async () => {
    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        critique: 'Still harmful',
        harmScores: [
          {
            category: 'violence',
            severity: 'high',
            confidence: 0.95,
            principleViolated: 'no-violence',
          },
        ],
        principlesViolated: ['no-violence'],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await reviser.critiqueAndRevise('Persistently harmful', []);

    expect(result.iterations).toBeLessThanOrEqual(3);
  });
});

describe('ConstitutionalAI', () => {
  let ai: ConstitutionalAI;
  let mockLLM: LLMBackend;

  beforeEach(() => {
    mockLLM = createMockLLM();
    ai = new ConstitutionalAI({
      llm: mockLLM,
      config: createGuardrailConfig(),
    });
  });

  it('initializes with default constitution', () => {
    expect(ai.getConstitution().id).toBe('cogitator-default-v1');
  });

  it('filters input', async () => {
    const result = await ai.filterInput('Safe question');

    expect(result.allowed).toBe(true);
  });

  it('filters output', async () => {
    const result = await ai.filterOutput('Safe answer', []);

    expect(result.allowed).toBe(true);
  });

  it('guards tools', async () => {
    const tool: Tool = {
      name: 'safe_tool',
      description: 'A safe tool',
      parameters: z.object({}),
      execute: async () => ({}),
    };

    const result = await ai.guardTool(
      tool,
      {},
      {
        agentId: 'agent_1',
        runId: 'run_1',
        signal: new AbortController().signal,
      }
    );

    expect(result.approved).toBe(true);
  });

  it('sets and gets constitution', () => {
    const newConstitution = createConstitution([], { id: 'custom' });
    ai.setConstitution(newConstitution);

    expect(ai.getConstitution().id).toBe('custom');
  });

  it('adds principle', () => {
    const principle: ConstitutionalPrinciple = {
      id: 'new-principle',
      name: 'New',
      description: 'A new principle',
      category: 'custom',
      critiquePrompt: 'Check',
      revisionPrompt: 'Fix',
      severity: 'low',
    };

    ai.addPrinciple(principle);

    const constitution = ai.getConstitution();
    expect(constitution.principles.some((p) => p.id === 'new-principle')).toBe(true);
  });

  it('removes principle', () => {
    ai.removePrinciple('no-violence');

    const constitution = ai.getConstitution();
    expect(constitution.principles.some((p) => p.id === 'no-violence')).toBe(false);
  });

  it('logs violations', async () => {
    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'violence', severity: 'high', confidence: 0.9 }],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    await ai.filterInput('Harmful input');

    const log = ai.getViolationLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].layer).toBe('input');
  });

  it('clears violation log', async () => {
    mockLLM.chat = vi.fn().mockResolvedValue({
      id: 'test',
      content: JSON.stringify({
        isHarmful: true,
        harmScores: [{ category: 'violence', severity: 'high', confidence: 0.9 }],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    await ai.filterInput('Harmful');
    ai.clearViolationLog();

    expect(ai.getViolationLog()).toHaveLength(0);
  });

  it('returns config copy', () => {
    const config1 = ai.getConfig();
    const config2 = ai.getConfig();

    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);
  });

  it('skips input filter when disabled', async () => {
    const aiDisabled = new ConstitutionalAI({
      llm: mockLLM,
      config: { ...createGuardrailConfig(), filterInput: false },
    });

    const result = await aiDisabled.filterInput('Any input');

    expect(result.allowed).toBe(true);
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });

  it('skips output filter when disabled', async () => {
    const aiDisabled = new ConstitutionalAI({
      llm: mockLLM,
      config: { ...createGuardrailConfig(), filterOutput: false },
    });

    const result = await aiDisabled.filterOutput('Any output', []);

    expect(result.allowed).toBe(true);
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });

  it('skips tool guard when disabled', async () => {
    const aiDisabled = new ConstitutionalAI({
      llm: mockLLM,
      config: { ...createGuardrailConfig(), filterToolCalls: false },
    });

    const tool: Tool = {
      name: 'any_tool',
      description: 'Test',
      parameters: z.object({}),
      execute: async () => ({}),
      sideEffects: ['process'],
    };

    const result = await aiDisabled.guardTool(
      tool,
      {},
      {
        agentId: 'a',
        runId: 'r',
        signal: new AbortController().signal,
      }
    );

    expect(result.approved).toBe(true);
  });
});
