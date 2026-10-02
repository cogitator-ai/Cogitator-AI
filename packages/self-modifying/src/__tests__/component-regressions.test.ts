import { describe, it, expect, vi } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  GeneratedTool,
  LLMBackend,
  MetaAssessment,
  MetaObservation,
  Tool,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import {
  GapAnalyzer,
  ToolGenerator,
  ToolValidator,
  parseToolGenerationResponse,
} from '../tool-generation';
import { MetaReasoner, parseMetaAssessmentResponse } from '../meta-reasoning';
import {
  CapabilityAnalyzer,
  ParameterOptimizer,
  buildCandidateGenerationPrompt,
  parseCandidateGenerationResponse,
  parseTaskProfileResponse,
} from '../architecture-evolution';
import { ModificationValidator } from '../constraints';

const toolConfig: ToolSelfGenerationConfig = {
  enabled: true,
  autoGenerate: true,
  maxToolsPerSession: 3,
  minConfidenceForGeneration: 0.5,
  maxIterationsPerTool: 2,
  requireLLMValidation: false,
  sandboxConfig: {
    enabled: true,
    maxExecutionTime: 3000,
    maxMemory: 50 * 1024 * 1024,
    allowedModules: [],
    isolationLevel: 'strict',
  },
};

function response(content: string): ChatResponse {
  return {
    id: 'resp',
    content,
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function chatBackend(reply: (request: ChatRequest) => string): LLMBackend & {
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn(async (request: ChatRequest) => response(reply(request)));
  return {
    provider: 'ollama',
    chat,
    chatStream: async function* () {
      yield { id: 'x', delta: {} };
    },
  };
}

function makeGenerated(overrides: Partial<GeneratedTool>): GeneratedTool {
  return {
    id: 'gen_1',
    name: 'tool',
    description: 'tool',
    implementation: 'async function execute(p) { return p; }',
    parameters: { type: 'object', properties: {} },
    createdAt: new Date(),
    version: 1,
    status: 'validated',
    ...overrides,
  };
}

describe('ToolValidator regressions', () => {
  const validator = new ToolValidator({ config: toolConfig });

  it('does not flag RegExp.prototype.exec as shell execution', async () => {
    const result = await validator.validate(
      makeGenerated({
        implementation: `async function execute(params) {
          if (typeof params.text !== 'string') throw new Error('text required');
          const match = /(\\d+)/.exec(params.text);
          return match ? match[1] : '';
        }`,
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      })
    );

    expect(result.securityIssues).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('still flags bare exec() calls', async () => {
    const result = await validator.validate(
      makeGenerated({ implementation: 'async function execute(p) { return exec("ls"); }' })
    );

    expect(result.securityIssues.some((i) => i.includes('no_shell_commands'))).toBe(true);
  });

  it('surfaces info-level findings as suggestions', async () => {
    const result = await validator.validate(
      makeGenerated({ implementation: 'async function execute(p) { return 1; }' })
    );

    expect(result.suggestions.some((s) => s.includes('has_error_handling'))).toBe(true);
  });

  it('accepts a correct tool with required and optional parameters', async () => {
    const result = await validator.validate(
      makeGenerated({
        implementation: `async function execute(params) {
          if (typeof params.value !== 'number') throw new Error('value must be a number');
          const factor = typeof params.factor === 'number' ? params.factor : 2;
          return params.value * factor;
        }`,
        parameters: {
          type: 'object',
          properties: { value: { type: 'number' }, factor: { type: 'number' } },
          required: ['value'],
        },
      })
    );

    expect(result.logicIssues).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('accepts tools that reject edge-case input with a descriptive error', async () => {
    const result = await validator.validate(
      makeGenerated({
        implementation: `async function execute(params) {
          if (!params.text) throw new Error('text must be a non-empty string');
          return params.text.split('').reverse().join('');
        }`,
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      })
    );

    expect(result.isValid).toBe(true);
  });
});

describe('ToolGenerator regressions', () => {
  const generatedJson = JSON.stringify({
    name: 'Double Number',
    description: 'Double a number',
    implementation:
      "async function execute(params) { if (typeof params.value !== 'number') { throw new Error('value required'); } return params.value * 2; }",
    parameters: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    },
  });

  it('exposes a flat JSON schema from executable tools', async () => {
    const llm = chatBackend(() => generatedJson);
    const generator = new ToolGenerator({ llm, config: toolConfig, model: 'm' });
    const tool = parseToolGenerationResponse(generatedJson);
    expect(tool).not.toBeNull();

    const executable = generator.createExecutableTool(tool!);

    expect(executable.toJSON()).toEqual({
      name: 'double_number',
      description: 'Double a number',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
    });
    await expect(
      executable.execute(
        { value: 4 },
        { agentId: 'a', runId: 'r', signal: new AbortController().signal }
      )
    ).resolves.toBe(8);
  });

  it('passes the configured model to backends implementing complete()', async () => {
    const complete = vi.fn(async () => response(generatedJson));
    const llm: LLMBackend = {
      provider: 'ollama',
      chat: vi.fn(),
      chatStream: async function* () {
        yield { id: 'x', delta: {} };
      },
      complete,
    };
    const generator = new ToolGenerator({ llm, config: toolConfig, model: 'my-model' });

    await generator.generate(
      {
        id: 'g',
        description: 'Double a number',
        requiredCapability: 'value * 2',
        suggestedToolName: 'double_number',
        complexity: 'simple',
        confidence: 1,
      },
      []
    );

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-model' }));
  });

  it('generateQuick enforces the requested parameters and returns null on failure', async () => {
    const llm = chatBackend(() => generatedJson);
    const generator = new ToolGenerator({ llm, config: toolConfig, model: 'm' });

    const tool = await generator.generateQuick('Double a number', 'double_number', {
      value: { type: 'number' },
    });

    expect(tool?.parameters).toEqual({ type: 'object', properties: { value: { type: 'number' } } });
    const prompt = llm.chat.mock.calls[0][0].messages[1].content;
    expect(prompt).toContain('MUST accept exactly this parameters JSON Schema');

    const failing = new ToolGenerator({
      llm: chatBackend(() => 'no json here'),
      config: toolConfig,
      model: 'm',
    });
    await expect(failing.generateQuick('Nothing', 'nothing', {})).resolves.toBeNull();
  });
});

describe('GapAnalyzer regressions', () => {
  it('does not reuse cached analysis when failure context changes', async () => {
    const llm = chatBackend(() => JSON.stringify({ hasGap: false, gaps: [], canProceed: true }));
    const analyzer = new GapAnalyzer({ llm, config: toolConfig, model: 'm' });
    const tools: Tool[] = [];

    await analyzer.analyze('convert units', tools);
    await analyzer.analyze('convert units', tools);
    await analyzer.analyze('convert units', tools, { failedAttempts: ['unit_converter failed'] });

    expect(llm.chat).toHaveBeenCalledTimes(2);
  });
});

type MetaReasonerTriggers = NonNullable<
  ConstructorParameters<typeof MetaReasoner>[0]['config']
>['triggers'];
const DEFAULT_TRIGGERS: MetaReasonerTriggers = ['on_failure', 'on_low_confidence', 'periodic'];

describe('MetaReasoner regressions', () => {
  const observation: MetaObservation = {
    runId: 'run',
    iteration: 1,
    timestamp: Date.now(),
    currentMode: 'analytical',
    currentConfidence: 0.2,
    progressScore: 0,
    progressDelta: 0,
    stagnationCount: 0,
    confidenceHistory: [],
    tokensUsed: 0,
    timeElapsed: 0,
    toolSuccessRate: 1,
    repetitionScore: 0,
    confidenceTrend: 'stable',
  };

  function makeReasoner(llmReply = '{}', triggers = DEFAULT_TRIGGERS) {
    return new MetaReasoner({
      llm: chatBackend(() => llmReply),
      model: 'm',
      config: {
        metaAssessmentCooldown: 0,
        adaptationCooldown: 0,
        triggers,
      },
    });
  }

  function assessmentWith(recommendation: MetaAssessment['recommendation']): MetaAssessment {
    return {
      id: 'a1',
      observationId: 'o1',
      timestamp: Date.now(),
      onTrack: false,
      confidence: 0.5,
      reasoning: '',
      issues: [],
      opportunities: [],
      recommendation,
      assessmentDuration: 0,
      assessmentCost: 0,
    };
  }

  it('honors the configured trigger list including aliases', () => {
    const reasoner = makeReasoner('{}', ['on_failure', 'progress_stall']);
    reasoner.initializeRun('run');
    const ctx = { iteration: 3, confidence: 0.1, progressDelta: 0, stagnationCount: 5 };

    expect(reasoner.shouldTrigger('run', 'on_failure', ctx)).toBe(true);
    expect(reasoner.shouldTrigger('run', 'tool_call_failed', ctx)).toBe(true);
    expect(reasoner.shouldTrigger('run', 'on_stagnation', ctx)).toBe(true);
    expect(reasoner.shouldTrigger('run', 'on_low_confidence', ctx)).toBe(false);
    expect(reasoner.shouldTrigger('run', 'iteration_complete', ctx)).toBe(false);
    expect(reasoner.shouldTrigger('run', 'explicit_request', ctx)).toBe(true);
  });

  it('ignores recommendations without a valid confidence', async () => {
    const reasoner = makeReasoner(
      JSON.stringify({ recommendation: { action: 'switch_mode', newMode: 'creative' } })
    );
    reasoner.initializeRun('run');

    const assessment = await reasoner.assess(observation);
    const adaptation = await reasoner.adapt('run', assessment);

    expect(assessment.recommendation.confidence).toBe(0);
    expect(adaptation).toBeNull();
    expect(reasoner.getCurrentMode('run')).toBe('analytical');
  });

  it('does not record no-op adaptations', async () => {
    const reasoner = makeReasoner();
    reasoner.initializeRun('run');

    const invalidMode = await reasoner.adapt(
      'run',
      assessmentWith({ action: 'switch_mode', confidence: 0.9, reasoning: '' })
    );
    const noParams = await reasoner.adapt(
      'run',
      assessmentWith({ action: 'adjust_parameters', confidence: 0.9, reasoning: '' })
    );

    expect(invalidMode).toBeNull();
    expect(noParams).toBeNull();
    expect(reasoner.getRunStats('run').adaptations).toBe(0);
  });

  it('applies parameter adjustments to the current config and rolls them back', async () => {
    const reasoner = makeReasoner();
    reasoner.initializeRun('run');

    const adaptation = await reasoner.adapt(
      'run',
      assessmentWith({
        action: 'adjust_parameters',
        parameterChanges: { temperature: 1.1 },
        confidence: 0.9,
        reasoning: 'explore more',
      })
    );

    expect(adaptation?.type).toBe('parameter_change');
    expect(reasoner.getCurrentConfig('run').temperature).toBe(1.1);

    const rollback = reasoner.rollback('run', adaptation!.id);
    expect(rollback?.type).toBe('rollback');
    expect(reasoner.getCurrentConfig('run').temperature).toBe(0.3);
  });

  it('records previous and new mode on mode switches', async () => {
    const reasoner = makeReasoner();
    reasoner.initializeRun('run');

    const adaptation = await reasoner.adapt(
      'run',
      assessmentWith({ action: 'switch_mode', newMode: 'creative', confidence: 0.9, reasoning: '' })
    );

    expect(adaptation).toMatchObject({ previousMode: 'analytical', newMode: 'creative' });
    expect(reasoner.getCurrentConfig('run').temperature).toBe(0.9);
  });

  it('drops invalid enum values and clamps numbers from LLM assessments', () => {
    const parsed = parseMetaAssessmentResponse(
      JSON.stringify({
        onTrack: 'yes',
        confidence: 7,
        recommendation: {
          action: 'adjust_parameters',
          newMode: 'chaotic',
          parameterChanges: { temperature: 9, depth: 2.6, unknown: 1 },
          confidence: 0.8,
        },
      })
    );

    expect(parsed?.onTrack).toBeUndefined();
    expect(parsed?.confidence).toBe(1);
    expect(parsed?.recommendation).toMatchObject({
      action: 'adjust_parameters',
      newMode: undefined,
      parameterChanges: { temperature: 2, depth: 3 },
    });
  });
});

describe('Architecture evolution regressions', () => {
  it('drops hallucinated models and invalid values from candidate configs', () => {
    const candidates = parseCandidateGenerationResponse(
      JSON.stringify([
        { id: 'a', config: { model: 'gpt-imaginary', temperature: 5, maxTokens: -3 }, risk: 'low' },
        { id: 'b', config: { model: 'llama3', reflectionDepth: 9.4, toolStrategy: 'warp' } },
        { id: 'c', config: { model: 'unknown' } },
        { id: 'baseline', config: { temperature: 0.2 } },
      ]),
      { availableModels: ['llama3'] }
    );

    expect(candidates.map((c) => c.id)).toEqual(['a', 'b', 'baseline_3']);
    expect(candidates[0].config).toEqual({ temperature: 2, maxTokens: 100 });
    expect(candidates[1].config).toEqual({ model: 'llama3', reflectionDepth: 5 });
  });

  it('only asks for model changes when models are available', () => {
    const profile = parseTaskProfileResponse('{}')!;
    const base = {
      model: 'm',
      temperature: 0.7,
      maxTokens: 1000,
      toolStrategy: 'sequential' as const,
      reflectionDepth: 0,
    };

    expect(buildCandidateGenerationPrompt(profile, base)).toContain('Do not change the model');
    expect(buildCandidateGenerationPrompt(profile, base, [], { availableModels: ['x'] })).toContain(
      'Only use models from this list: x'
    );
  });

  it('falls back to defaults for invalid task profile enums', () => {
    const profile = parseTaskProfileResponse(
      JSON.stringify({ complexity: 'very hard', domain: 'cooking', estimatedTokens: 'many' })
    );

    expect(profile).toMatchObject({
      complexity: 'moderate',
      domain: 'general',
      estimatedTokens: 1000,
    });
  });

  it('adopts unexplored low-risk candidates, filters high-risk ones and learns from outcomes', async () => {
    const llm = chatBackend((request) =>
      request.messages[0].content.toString().includes('architecture optimizer')
        ? JSON.stringify([
            { id: 'safe', config: { temperature: 0.4 }, risk: 'low' },
            { id: 'risky', config: { temperature: 1.9 }, risk: 'high' },
          ])
        : JSON.stringify({ complexity: 'simple', domain: 'general' })
    );
    const optimizer = new ParameterOptimizer({
      llm,
      model: 'm',
      config: { enabled: true, strategy: { type: 'ucb' } },
      baseConfig: {
        model: 'm',
        temperature: 0.7,
        maxTokens: 1000,
        toolStrategy: 'sequential',
        reflectionDepth: 0,
      },
    });

    const first = await optimizer.optimize('task');
    expect(optimizer.getCandidates().map((c) => c.id)).toEqual(['baseline', 'safe']);
    expect(first.shouldAdopt).toBe(true);
    expect(first.taskProfile.complexity).toBe('simple');

    await optimizer.recordOutcome(first.candidate!.id, first.taskProfile, {
      successRate: 1,
      latency: 100,
      tokenUsage: 100,
      qualityScore: 0.9,
    });

    const second = await optimizer.optimize('task');
    expect(second.candidate?.id).not.toBe(first.candidate?.id);
    expect(second.shouldAdopt).toBe(true);
  });
});

describe('CapabilityAnalyzer regressions', () => {
  it('matches keywords on word boundaries', async () => {
    const analyzer = new CapabilityAnalyzer();
    const profile = await analyzer.analyzeTask('Which of these values is the largest');

    expect(profile.domain).not.toBe('conversational');
  });

  it('does not share cache entries between long tasks with the same prefix', async () => {
    const analyzer = new CapabilityAnalyzer();
    const prefix = 'context '.repeat(40);

    const coding = await analyzer.analyzeTask(`${prefix} debug this typescript function`);
    const creative = await analyzer.analyzeTask(`${prefix} write a poem and a story`);

    expect(coding.domain).toBe('coding');
    expect(creative.domain).toBe('creative');
  });
});

describe('ModificationValidator regressions', () => {
  it('does not apply tool-only safety constraints to config changes', async () => {
    const validator = new ModificationValidator();

    const result = await validator.validate({
      type: 'config_change',
      target: 'architecture',
      changes: { temperature: 0.4 },
      reason: 'tune',
    });

    expect(result.valid).toBe(true);
    expect(result.rollbackRequired).toBe(false);
  });

  it('handles tool generation requests without payload', async () => {
    const validator = new ModificationValidator();

    const result = await validator.validate({
      type: 'tool_generation',
      target: 'x',
      changes: {},
      reason: 'no payload',
    });

    expect(result.valid).toBe(false);
    expect(result.rollbackRequired).toBe(true);
  });

  it('supports quoted strings and negative numbers in rules', async () => {
    const validator = new ModificationValidator({
      constraints: {
        safety: [
          {
            id: 'category_rule',
            rule: "category = 'math' AND offset > -5",
            severity: 'error',
            description: 'math only',
          },
        ],
      },
    });

    const ok = await validator.validate({
      type: 'config_change',
      target: 't',
      changes: {},
      reason: '',
      payload: { category: 'math', offset: -2 },
    });
    const bad = await validator.validate({
      type: 'config_change',
      target: 't',
      changes: {},
      reason: '',
      payload: { category: 'net', offset: -2 },
    });

    expect(ok.valid).toBe(true);
    expect(bad.valid).toBe(false);
  });
});

describe('executable tool parameter validation', () => {
  it('rejects arguments that do not match the generated schema', async () => {
    const generator = new ToolGenerator({ llm: chatBackend(() => ''), config: toolConfig });
    const executable = generator.createExecutableTool(
      makeGenerated({
        name: 'double',
        implementation: 'async function execute(p) { return p.value * 2; }',
        parameters: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
      })
    );

    expect(executable.parameters.safeParse({ value: 'x' }).success).toBe(false);
    expect(executable.parameters.safeParse({ value: 2 }).success).toBe(true);
  });
});
