import { describe, it, expect, vi } from 'vitest';
import type {
  CapabilityGap,
  ChatRequest,
  ChatResponse,
  GeneratedTool,
  LLMBackend,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import {
  GapAnalyzer,
  ToolGenerator,
  ToolValidator,
  buildGapAnalysisPrompt,
  buildToolGenerationPrompt,
  parseToolGenerationResponse,
} from '../tool-generation';
import { CapabilityAnalyzer, ParameterOptimizer } from '../architecture-evolution';

const config: ToolSelfGenerationConfig = {
  enabled: true,
  autoGenerate: true,
  maxToolsPerSession: 3,
  minConfidenceForGeneration: 0.5,
  maxIterationsPerTool: 2,
  requireLLMValidation: true,
  sandboxConfig: {
    enabled: true,
    maxExecutionTime: 3000,
    maxMemory: 50 * 1024 * 1024,
    allowedModules: [],
    isolationLevel: 'strict',
  },
};

const LUHN = `async function execute(params) {
  if (typeof params.digits !== 'string' || !/^[0-9]+$/.test(params.digits)) {
    throw new Error('digits must be a non-empty string of 0-9');
  }
  let sum = 0;
  for (let i = 0; i < params.digits.length; i++) {
    let digit = Number(params.digits[params.digits.length - 1 - i]);
    if (i % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}`;

const DIGITS_SCHEMA = {
  type: 'object',
  properties: { digits: { type: 'string', description: 'Decimal digits only' } },
  required: ['digits'],
};

function luhnTool(overrides: Partial<GeneratedTool> = {}): GeneratedTool {
  return {
    id: 'gen_luhn',
    name: 'luhn_check_digit',
    description: 'Computes the Luhn check digit of a digit string',
    implementation: LUHN,
    parameters: DIGITS_SCHEMA,
    createdAt: new Date(),
    version: 1,
    status: 'pending_validation',
    ...overrides,
  };
}

function response(content: string): ChatResponse {
  return {
    id: 'resp',
    content,
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function backend(reply: (request: ChatRequest) => string): LLMBackend & {
  chat: ReturnType<typeof vi.fn>;
} {
  const chat = vi.fn(async (request: ChatRequest) => response(reply(request)));
  return {
    provider: 'stub',
    chat,
    chatStream: async function* () {
      yield { id: 'x', delta: {} };
    },
  };
}

function reviewer(review: Record<string, unknown>) {
  return backend(() => JSON.stringify(review));
}

const CRC_GAP: CapabilityGap = {
  id: 'gap_crc',
  description: 'No available tool to reliably compute the CRC-32 checksum of a text',
  requiredCapability: 'CRC-32 (IEEE 802.3) checksum of a UTF-8 text as 8 lowercase hex digits',
  suggestedToolName: 'crc32_calculator',
  complexity: 'simple',
  confidence: 0.9,
};

const CRC_IMPLEMENTATION =
  "async function execute(params) { if (typeof params.text !== 'string') { throw new Error('text must be a string'); } let crc = -1; for (let i = 0; i < params.text.length; i++) { crc ^= params.text.charCodeAt(i); for (let k = 0; k < 8; k++) { crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } } return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0'); }";

function crcToolJson(description: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'crc32_calculator',
    description,
    implementation: CRC_IMPLEMENTATION,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    ...extra,
  });
}

describe('ToolValidator without a review', () => {
  const validator = new ToolValidator({ config: { ...config, requireLLMValidation: false } });

  it('accepts a correct tool that rejects malformed input', async () => {
    const result = await validator.validate(luhnTool());

    expect(result.logicIssues).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it('runs the examples the generator gave as cases that must succeed', async () => {
    const broken = luhnTool({
      implementation:
        "async function execute(params) { if (params.digits.length > 3) { throw new Error('unsupported'); } return 0; }",
      metadata: { examples: [{ input: { digits: '7992739871' } }] },
    });

    const result = await validator.validate(broken);

    expect(result.isValid).toBe(false);
    expect(result.logicIssues.join('\n')).toContain('7992739871');
  });

  it('ignores examples that do not fit the parameters schema', async () => {
    const result = await validator.validate(
      luhnTool({
        metadata: {
          examples: [{ input: { digits: 42 } }, { input: { number: '123' } }, { input: 'x' }],
        },
      })
    );

    expect(result.isValid).toBe(true);
    expect(result.testResults.some((test) => JSON.stringify(test.input).includes('number'))).toBe(
      false
    );
  });
});

describe('ToolValidator with a review', () => {
  it('follows an approving review and keeps its notes as suggestions', async () => {
    const validator = new ToolValidator({
      llm: reviewer({
        isValid: true,
        recommendation: 'approve',
        overallScore: 0.95,
        securityIssues: ['No upper bound on the input length'],
        logicIssues: ['Could also accept numbers'],
        edgeCases: [],
        suggestions: ['Consider documenting the return type'],
      }),
      model: 'stub',
      config,
    });

    const result = await validator.validate(luhnTool(), [
      { input: { digits: '7992739871' }, expectedOutput: 3 },
      { input: { digits: '12a4' }, shouldThrow: true },
    ]);

    expect(result.isValid).toBe(true);
    expect(result.overallScore).toBeGreaterThanOrEqual(0.7);
    expect(result.securityIssues).toEqual([]);
    expect(result.logicIssues).toEqual([]);
    expect(result.suggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No upper bound on the input length'),
        expect.stringContaining('Could also accept numbers'),
        'Consider documenting the return type',
      ])
    );
  });

  it('rejects the tool when the review rejects it', async () => {
    const validator = new ToolValidator({
      llm: reviewer({
        isValid: false,
        recommendation: 'reject',
        overallScore: 0.1,
        securityIssues: ['Builds a regular expression from user input'],
        logicIssues: [],
        edgeCases: [],
        suggestions: [],
      }),
      model: 'stub',
      config,
    });

    const result = await validator.validate(luhnTool());

    expect(result.isValid).toBe(false);
    expect(result.securityIssues).toContain('Builds a regular expression from user input');
    expect(result.overallScore).toBe(0);
  });

  it('asks for a revision when the review recommends one', async () => {
    const validator = new ToolValidator({
      llm: reviewer({
        isValid: true,
        recommendation: 'revise',
        securityIssues: [],
        logicIssues: ['Returns a string instead of a number'],
      }),
      model: 'stub',
      config,
    });

    const result = await validator.validate(luhnTool());

    expect(result.isValid).toBe(false);
    expect(result.logicIssues).toContain('Returns a string instead of a number');
  });

  it('gives a rejecting review without findings something to fix', async () => {
    const validator = new ToolValidator({
      llm: reviewer({ isValid: false, recommendation: 'reject' }),
      model: 'stub',
      config,
    });

    const result = await validator.validate(luhnTool());

    expect(result.isValid).toBe(false);
    expect(result.logicIssues.length).toBeGreaterThan(0);
  });

  it('keeps the static security checks authoritative over an approving review', async () => {
    const llm = reviewer({ isValid: true, recommendation: 'approve', securityIssues: [] });
    const validator = new ToolValidator({ llm, model: 'stub', config });

    const result = await validator.validate(
      luhnTool({ implementation: "async function execute(p) { return eval('1 + 1'); }" })
    );

    expect(result.isValid).toBe(false);
    expect(result.overallScore).toBe(0);
    expect(result.securityIssues.some((issue) => issue.includes('no_eval'))).toBe(true);
  });

  it('keeps failed sandbox tests authoritative over an approving review', async () => {
    const llm = reviewer({ isValid: true, recommendation: 'approve' });
    const validator = new ToolValidator({ llm, model: 'stub', config });

    const result = await validator.validate(luhnTool(), [
      { input: { digits: '7992739871' }, expectedOutput: 4 },
    ]);

    expect(result.isValid).toBe(false);
    expect(result.logicIssues.join('\n')).toContain('7992739871');
  });

  it('bounds the review call with maxTokens', async () => {
    const llm = reviewer({ isValid: true, recommendation: 'approve' });
    const validator = new ToolValidator({ llm, model: 'stub', config, maxTokens: 900 });

    await validator.validate(luhnTool());

    expect(llm.chat.mock.calls[0]?.[0].maxTokens).toBe(900);
  });
});

describe('generated tool description', () => {
  it('asks the model to describe the tool, not the gap', () => {
    const prompt = buildToolGenerationPrompt(CRC_GAP, []);

    expect(prompt).not.toContain(`"description":"${CRC_GAP.description}"`);
    expect(prompt).toContain('"examples"');
  });

  it('keeps the description the model wrote for the tool', async () => {
    const llm = backend(() =>
      crcToolJson('Computes the CRC-32 checksum of a text as 8 lowercase hex digits')
    );
    const generator = new ToolGenerator({
      llm,
      model: 'stub',
      config: { ...config, requireLLMValidation: false },
    });

    const result = await generator.generate(CRC_GAP, []);

    expect(result.success).toBe(true);
    expect(result.tool?.description).toBe(
      'Computes the CRC-32 checksum of a text as 8 lowercase hex digits'
    );
    expect(result.tool?.metadata?.capability).toBe(CRC_GAP.requiredCapability);
  });

  it('describes the tool by its capability when the model echoes the gap', async () => {
    const llm = backend(() => crcToolJson(CRC_GAP.description));
    const generator = new ToolGenerator({
      llm,
      model: 'stub',
      config: { ...config, requireLLMValidation: false },
    });

    const result = await generator.generate(CRC_GAP, []);

    expect(result.tool?.description).toBe(CRC_GAP.requiredCapability);
  });

  it('describes the tool by its capability when the model leaves the description out', async () => {
    const llm = backend(() => crcToolJson(''));
    const generator = new ToolGenerator({
      llm,
      model: 'stub',
      config: { ...config, requireLLMValidation: false },
    });

    const result = await generator.generate(CRC_GAP, []);

    expect(result.tool?.description).toBe(CRC_GAP.requiredCapability);
  });

  it('reads valid example inputs from the generation response', () => {
    const tool = parseToolGenerationResponse(
      crcToolJson('CRC-32 of a text', {
        examples: [{ input: { text: 'abc' } }, { text: 'bare input' }, 'junk'],
      })
    );

    expect(tool?.metadata?.examples).toEqual([
      { input: { text: 'abc' } },
      { input: { text: 'bare input' } },
    ]);
  });

  it('keeps earlier examples when an improved version brings none', async () => {
    let call = 0;
    const llm = backend(() => {
      call++;
      return call === 1
        ? JSON.stringify({
            name: 'crc32_calculator',
            description: 'CRC-32 of a text',
            implementation: "async function execute(params) { throw new Error('todo'); }",
            parameters: { type: 'object', properties: { text: { type: 'string' } } },
            examples: [{ input: { text: 'abc' } }],
          })
        : crcToolJson('CRC-32 of a text');
    });
    const generator = new ToolGenerator({
      llm,
      model: 'stub',
      config: { ...config, requireLLMValidation: false },
    });

    const result = await generator.generate(CRC_GAP, []);

    expect(result.success).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.tool?.metadata?.examples).toEqual([{ input: { text: 'abc' } }]);
  });

  it('bounds generation calls with maxTokens', async () => {
    const llm = backend(() => crcToolJson('CRC-32 of a text'));
    const generator = new ToolGenerator({ llm, model: 'stub', config, maxTokens: 1200 });

    await generator.generate(CRC_GAP, []);

    expect(llm.chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [request] of llm.chat.mock.calls) {
      expect(request.maxTokens).toBe(1200);
    }
  });
});

describe('gap analysis context', () => {
  it('shows the agent instructions to the analyzer', async () => {
    const llm = backend(() => '{"hasGap":false,"gaps":[],"canProceed":true}');
    const analyzer = new GapAnalyzer({ llm, model: 'stub', config, maxTokens: 700 });

    await analyzer.analyze('What is the CRC-32 of "abc"?', [], {
      instructions: 'Never compute checksums yourself: always call a tool.',
    });

    const request = llm.chat.mock.calls[0]?.[0] as ChatRequest;
    expect(String(request.messages[1]?.content)).toContain(
      'Never compute checksums yourself: always call a tool.'
    );
    expect(request.maxTokens).toBe(700);
  });

  it('does not reuse a cached analysis made under other instructions', async () => {
    const llm = backend(() => '{"hasGap":false,"gaps":[],"canProceed":true}');
    const analyzer = new GapAnalyzer({ llm, model: 'stub', config });

    await analyzer.analyze('task', [], { instructions: 'one' });
    await analyzer.analyze('task', [], { instructions: 'two' });

    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('tells the analyzer that listed tools cover their capability', () => {
    const prompt = buildGapAnalysisPrompt(
      'CRC-32 of "abc"',
      [{ name: 'crc32_calculator', description: 'Computes the CRC-32 checksum of a text' }],
      undefined,
      'Always call a tool.'
    );

    expect(prompt).toContain('crc32_calculator: Computes the CRC-32 checksum of a text');
    expect(prompt).toContain('AGENT INSTRUCTIONS');
    expect(prompt).toMatch(/already provides/i);
  });
});

describe('architecture evolution maxTokens', () => {
  it('bounds the task profile call of the capability analyzer', async () => {
    const llm = backend(() => '{}');
    const analyzer = new CapabilityAnalyzer({
      llm,
      model: 'stub',
      enableLLMAnalysis: true,
      maxTokens: 400,
    });

    await analyzer.analyzeTask('Summarize this text in one line');

    expect(llm.chat.mock.calls[0]?.[0].maxTokens).toBe(400);
  });

  it('bounds the calls of the parameter optimizer', async () => {
    const llm = backend(() => '[]');
    const optimizer = new ParameterOptimizer({
      llm,
      model: 'stub',
      maxTokens: 500,
      config: {
        enabled: true,
        strategy: { type: 'ucb', explorationConstant: 2 },
        maxCandidates: 5,
        evaluationWindow: 5,
        minEvaluationsBeforeEvolution: 3,
        adaptationThreshold: 0.1,
      },
      baseConfig: {
        model: 'stub',
        temperature: 0.5,
        maxTokens: 1000,
        toolStrategy: 'sequential',
        reflectionDepth: 0,
      },
    });

    await optimizer.optimize('Summarize this text in one line');

    expect(llm.chat.mock.calls.length).toBeGreaterThan(0);
    for (const [request] of llm.chat.mock.calls) {
      expect(request.maxTokens).toBe(500);
    }
  });
});
