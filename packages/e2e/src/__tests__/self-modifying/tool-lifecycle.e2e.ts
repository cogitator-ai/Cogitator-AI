import { describe, it, expect, beforeAll } from 'vitest';
import {
  ToolGenerator,
  ToolSandbox,
  ToolValidator,
  GapAnalyzer,
  InMemoryGeneratedToolStore,
} from '@cogitator-ai/self-modifying';
import type { CapabilityGap, GeneratedTool, ToolSelfGenerationConfig } from '@cogitator-ai/types';
import { OllamaBackend } from '@cogitator-ai/core';
import { isOllamaRunning } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const TOOL_GEN_MODEL = process.env.TOOL_GEN_MODEL || process.env.TEST_MODEL || 'qwen2.5:0.5b';

const toolGenConfig: ToolSelfGenerationConfig = {
  enabled: true,
  autoGenerate: true,
  maxToolsPerSession: 5,
  minConfidenceForGeneration: 0.5,
  maxIterationsPerTool: 5,
  requireLLMValidation: false,
  maxComplexity: 'moderate',
  sandboxConfig: {
    enabled: true,
    maxExecutionTime: 5000,
    maxMemory: 50 * 1024 * 1024,
    allowedModules: [],
    isolationLevel: 'strict',
  },
};

function createBackend(): OllamaBackend {
  return new OllamaBackend({ baseUrl: OLLAMA_URL, defaultModel: TOOL_GEN_MODEL });
}

async function generateWithRetry(
  generator: ToolGenerator,
  gap: CapabilityGap,
  maxAttempts = 5
): Promise<{ success: boolean; tool: GeneratedTool | null }> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await generator.generate(gap, []);
    if (result.success && result.tool) return result;
  }
  return { success: false, tool: null };
}

describeE2E('self-modifying: tool lifecycle (real LLM)', () => {
  let backend: OllamaBackend;
  let generator: ToolGenerator;
  let sandbox: ToolSandbox;
  let validator: ToolValidator;

  beforeAll(async () => {
    const running = await isOllamaRunning();
    if (!running) throw new Error('Ollama is not running');

    backend = createBackend();
    generator = new ToolGenerator({ llm: backend, config: toolGenConfig, model: TOOL_GEN_MODEL });
    sandbox = new ToolSandbox(toolGenConfig.sandboxConfig);
    validator = new ToolValidator({ llm: backend, config: toolGenConfig, model: TOOL_GEN_MODEL });
  });

  it('generates a working tool from a capability gap', async () => {
    const gap: CapabilityGap = {
      id: 'gap_celsius_to_fahrenheit',
      description: 'Convert temperature from Celsius to Fahrenheit',
      requiredCapability: 'Temperature conversion: Fahrenheit = Celsius * 9/5 + 32',
      suggestedToolName: 'celsius_to_fahrenheit',
      complexity: 'simple',
      confidence: 1.0,
      reasoning: 'No temperature conversion tool available',
    };

    const result = await generateWithRetry(generator, gap);

    expect(result.success).toBe(true);
    expect(result.tool).not.toBeNull();
    expect(result.tool!.name).toBe('celsius_to_fahrenheit');
    expect(result.tool!.implementation).toContain('execute');

    const execResult = await sandbox.execute(result.tool!, { celsius: 100 });

    expect(execResult.success).toBe(true);
    expect(typeof execResult.result === 'number' || typeof execResult.result === 'object').toBe(
      true
    );

    let value: number;
    if (typeof execResult.result === 'number') {
      value = execResult.result;
    } else if (typeof execResult.result === 'string') {
      value = parseFloat(execResult.result);
    } else if (typeof execResult.result === 'object' && execResult.result !== null) {
      const obj = execResult.result as Record<string, unknown>;
      const candidate =
        obj.fahrenheit ??
        obj.result ??
        obj.temperature ??
        obj.value ??
        obj.output ??
        Object.values(obj).find((v) => typeof v === 'number');
      value = Number(candidate);
    } else {
      value = NaN;
    }

    expect(value).not.toBeNaN();
    expect(value).toBeCloseTo(212, 0);
  }, 180_000);

  it('validates generated tool with test cases', async () => {
    const gap: CapabilityGap = {
      id: 'gap_reverse_string',
      description: 'Reverse a string. Takes {text: string} and returns the reversed string.',
      requiredCapability:
        'String reversal: given input {text: "hello"} return "olleh". Return ONLY the reversed string, not an object.',
      suggestedToolName: 'reverse_string',
      complexity: 'simple',
      confidence: 1.0,
      reasoning: 'No string reversal tool available',
    };

    const result = await generateWithRetry(generator, gap);
    expect(result.success).toBe(true);
    expect(result.tool).not.toBeNull();

    const testCases = [
      { input: { text: 'hello' }, expectedOutput: 'olleh' },
      { input: { text: 'abc' }, expectedOutput: 'cba' },
      { input: { text: '' }, expectedOutput: '' },
    ];

    const testResult = await sandbox.testWithCases(result.tool!, testCases);

    expect(testResult.passed).toBeGreaterThanOrEqual(2);
    expect(testResult.results).toHaveLength(3);

    for (const r of testResult.results) {
      expect(r.error).toBeUndefined();
    }
  }, 180_000);

  it('rejects invalid/dangerous tool code', async () => {
    const dangerousTool: GeneratedTool = {
      id: 'dangerous_tool_1',
      name: 'file_reader',
      description: 'Reads files from disk',
      implementation: `
        const fs = require('fs');
        async function execute(params) {
          return fs.readFileSync(params.path, 'utf-8');
        }
      `,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    };

    const validationResult = await validator.validate(dangerousTool);
    expect(validationResult.isValid).toBe(false);
    expect(validationResult.securityIssues.length).toBeGreaterThan(0);

    const processExitTool: GeneratedTool = {
      id: 'dangerous_tool_2',
      name: 'exit_tool',
      description: 'Exits the process',
      implementation: `
        async function execute(params) {
          process.exit(params.code);
        }
      `,
      parameters: {
        type: 'object',
        properties: { code: { type: 'number' } },
        required: ['code'],
      },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    };

    const exitResult = await validator.validate(processExitTool);
    expect(exitResult.isValid).toBe(false);
    expect(exitResult.securityIssues.length).toBeGreaterThan(0);
  });

  it('full cycle: detect gap -> generate -> validate -> execute', async () => {
    const gapAnalyzer = new GapAnalyzer({
      llm: backend,
      config: toolGenConfig,
      model: TOOL_GEN_MODEL,
    });

    const analysis = await gapAnalyzer.analyze(
      'I need to calculate BMI (Body Mass Index) from weight in kg and height in meters. The formula is weight / (height * height).',
      []
    );

    expect(analysis.gaps.length).toBeGreaterThanOrEqual(0);

    const gap: CapabilityGap =
      analysis.gaps.length > 0
        ? analysis.gaps[0]
        : {
            id: 'gap_bmi_calc',
            description: 'Calculate BMI from weight and height',
            requiredCapability:
              'BMI calculation: BMI = weight / (height * height). Takes {weight: number, height: number} returns the BMI number.',
            suggestedToolName: 'calculate_bmi',
            complexity: 'simple',
            confidence: 1.0,
            reasoning: 'No BMI calculation tool available',
          };

    const genResult = await generateWithRetry(generator, gap);
    expect(genResult.success).toBe(true);
    expect(genResult.tool).not.toBeNull();

    const validationResult = await validator.validate(genResult.tool!);
    expect(validationResult.securityIssues).toHaveLength(0);

    const execResult = await sandbox.execute(genResult.tool!, { weight: 70, height: 1.75 });
    expect(execResult.success).toBe(true);

    const raw = execResult.result;
    let bmiValue: number;
    if (typeof raw === 'number') {
      bmiValue = raw;
    } else if (typeof raw === 'string') {
      bmiValue = parseFloat(raw);
    } else if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      const candidate =
        obj.bmi ??
        obj.BMI ??
        obj.result ??
        obj.value ??
        Object.values(obj).find((v) => typeof v === 'number');
      bmiValue = Number(candidate);
    } else {
      bmiValue = NaN;
    }

    expect(bmiValue).not.toBeNaN();
    while (bmiValue > 100) bmiValue /= 100;
    while (bmiValue > 0 && bmiValue < 1) bmiValue *= 100;
    expect(bmiValue).toBeCloseTo(22.86, 0);
  }, 180_000);

  it('generated tool persists in store and can be retrieved', async () => {
    const store = new InMemoryGeneratedToolStore();

    const gap: CapabilityGap = {
      id: 'gap_double_number',
      description:
        'Double a number. Takes {value: number} and returns the doubled value as a number.',
      requiredCapability:
        'Number doubling: return value * 2 as a plain number. Input {value: 5} should return 10.',
      suggestedToolName: 'double_number',
      complexity: 'simple',
      confidence: 1.0,
      reasoning: 'No number doubling tool available',
    };

    const genResult = await generateWithRetry(generator, gap);
    expect(genResult.success).toBe(true);
    expect(genResult.tool).not.toBeNull();
    const tool = genResult.tool!;

    await store.save(tool);

    const retrieved = await store.get(tool.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(tool.id);
    expect(retrieved!.name).toBe(tool.name);
    expect(retrieved!.implementation).toBe(tool.implementation);

    const execResult = await sandbox.execute(retrieved!, { value: 21 });
    expect(execResult.success).toBe(true);

    const doubledValue =
      typeof execResult.result === 'number'
        ? execResult.result
        : typeof execResult.result === 'object' && execResult.result !== null
          ? ((execResult.result as Record<string, unknown>).result ??
            (execResult.result as Record<string, unknown>).value ??
            (execResult.result as Record<string, unknown>).doubled)
          : NaN;

    expect(Number(doubledValue)).toBe(42);
  }, 180_000);
});
