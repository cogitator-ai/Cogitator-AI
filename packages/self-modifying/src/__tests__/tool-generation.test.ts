import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GapAnalyzer,
  ToolGenerator,
  ToolValidator,
  ToolSandbox,
  InMemoryGeneratedToolStore,
  parseGapAnalysisResponse,
  parseToolGenerationResponse,
} from '../tool-generation';
import type { LLMBackend, GeneratedTool, ToolSelfGenerationConfig } from '@cogitator-ai/types';

const mockToolConfig: ToolSelfGenerationConfig = {
  enabled: true,
  autoGenerate: true,
  maxToolsPerSession: 3,
  minConfidenceForGeneration: 0.7,
  maxIterationsPerTool: 3,
  requireLLMValidation: false,
  sandboxConfig: {
    enabled: true,
    maxExecutionTime: 5000,
    maxMemory: 50 * 1024 * 1024,
    allowedModules: [],
    isolationLevel: 'strict',
  },
};

const mockLLM: LLMBackend = {
  complete: vi.fn(),
  name: 'mock',
  supportsTool: () => true,
  supportsStreaming: () => false,
  validateConfig: () => true,
};

describe('ToolSandbox', () => {
  let sandbox: ToolSandbox;

  beforeEach(() => {
    sandbox = new ToolSandbox({ enabled: true, maxExecutionTime: 5000 });
  });

  it('executes safe code', async () => {
    const tool: GeneratedTool = {
      id: 'test-1',
      name: 'add',
      description: 'Add numbers',
      implementation: `
        async function execute(params) {
          return params.a + params.b;
        }
      `,
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      createdAt: new Date(),
      version: 1,
      status: 'validated',
    };

    const result = await sandbox.execute(tool, { a: 2, b: 3 });

    expect(result.success).toBe(true);
    expect(result.result).toBe(5);
  });

  it('rejects code with eval', async () => {
    const tool: GeneratedTool = {
      id: 'test-2',
      name: 'evil',
      description: 'Evil tool',
      implementation: `
        async function execute(params) {
          return eval(params.code);
        }
      `,
      parameters: { type: 'object', properties: { code: { type: 'string' } } },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    };

    const result = await sandbox.execute(tool, { code: '1+1' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Security violation');
  });

  it('blocks forbidden setTimeout', async () => {
    const shortTimeoutSandbox = new ToolSandbox({ enabled: true, maxExecutionTime: 100 });

    const tool: GeneratedTool = {
      id: 'test-3',
      name: 'slow',
      description: 'Slow tool',
      implementation: `
        async function execute(params) {
          await new Promise(r => setTimeout(r, 5000));
          return 'done';
        }
      `,
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'validated',
    };

    const result = await shortTimeoutSandbox.execute(tool, {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Security violation');
  });

  it('runs test cases', async () => {
    const tool: GeneratedTool = {
      id: 'test-4',
      name: 'multiply',
      description: 'Multiply numbers',
      implementation: `
        async function execute(params) {
          return params.a * params.b;
        }
      `,
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      createdAt: new Date(),
      version: 1,
      status: 'validated',
    };

    const result = await sandbox.testWithCases(tool, [
      { input: { a: 2, b: 3 }, expectedOutput: 6 },
      { input: { a: 0, b: 5 }, expectedOutput: 0 },
      { input: { a: -1, b: 3 }, expectedOutput: -3 },
    ]);

    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
  });
});

describe('ToolValidator', () => {
  let validator: ToolValidator;

  beforeEach(() => {
    validator = new ToolValidator({ config: mockToolConfig });
  });

  it('validates safe tools', async () => {
    const tool: GeneratedTool = {
      id: 'test-1',
      name: 'safe_tool',
      description: 'Safe tool',
      implementation: `
        async function execute(params) {
          return { result: params.value * 2 };
        }
      `,
      parameters: { type: 'object', properties: { value: { type: 'number' } } },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    };

    const result = await validator.validate(tool, [
      { input: { value: 5 }, expectedOutput: { result: 10 } },
    ]);

    expect(result.isValid).toBe(true);
    expect(result.securityIssues).toHaveLength(0);
  });

  it('detects security issues', async () => {
    const tool: GeneratedTool = {
      id: 'test-2',
      name: 'unsafe_tool',
      description: 'Unsafe tool',
      implementation: `
        async function execute(params) {
          const child_process = require('child_process');
          return child_process.execSync(params.cmd);
        }
      `,
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    };

    const result = await validator.validate(tool);

    expect(result.isValid).toBe(false);
    expect(result.securityIssues.length).toBeGreaterThan(0);
  });

  it('detects missing execute function', async () => {
    const tool: GeneratedTool = {
      id: 'test-3',
      name: 'no_execute',
      description: 'No execute',
      implementation: `
        function helper(x) { return x * 2; }
      `,
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    };

    const result = await validator.validate(tool);

    expect(result.isValid).toBe(false);
    expect(result.securityIssues.some((i) => i.includes('execute'))).toBe(true);
  });
});

describe('GapAnalyzer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('analyzes capability gaps', async () => {
    (mockLLM.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        hasGap: true,
        gaps: [
          {
            id: 'gap-1',
            description: 'Missing CSV parsing capability',
            requiredCapability: 'Parse CSV files',
            suggestedToolName: 'csv_parser',
            complexity: 'simple',
            confidence: 0.9,
            reasoning: 'User needs to analyze CSV data',
          },
        ],
        canProceed: false,
      }),
    });

    const analyzer = new GapAnalyzer({ llm: mockLLM, config: mockToolConfig });

    const result = await analyzer.analyze('Parse and analyze the sales.csv file', [
      {
        name: 'calculator',
        description: 'Perform calculations',
        parameters: {},
        execute: async () => null,
      },
    ]);

    expect(result.gaps.length).toBe(1);
    expect(result.gaps[0].suggestedToolName).toBe('csv_parser');
  });
});

describe('ToolGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates tools from gaps', async () => {
    (mockLLM.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify({
        name: 'csv_parser',
        description: 'Parse CSV data into JSON',
        implementation: `
          async function execute(params) {
            const lines = params.data.split('\\n');
            const headers = lines[0].split(',');
            return lines.slice(1).map(line => {
              const values = line.split(',');
              const obj = {};
              headers.forEach((h, i) => obj[h] = values[i]);
              return obj;
            });
          }
        `,
        parameters: {
          type: 'object',
          properties: { data: { type: 'string' } },
          required: ['data'],
        },
        reasoning: 'Simple CSV parsing without external dependencies',
      }),
    });

    const generator = new ToolGenerator({ llm: mockLLM, config: mockToolConfig });

    const result = await generator.generate(
      {
        id: 'gap-1',
        description: 'CSV parsing',
        requiredCapability: 'Parse CSV',
        suggestedToolName: 'csv_parser',
        complexity: 'simple',
        confidence: 0.9,
        reasoning: 'Needed for data analysis',
      },
      []
    );

    expect(result.success).toBe(true);
    expect(result.tool).not.toBeNull();
    expect(result.tool?.name).toBe('csv_parser');
  });
});

describe('InMemoryGeneratedToolStore', () => {
  let store: InMemoryGeneratedToolStore;

  beforeEach(() => {
    store = new InMemoryGeneratedToolStore();
  });

  it('saves and retrieves tools', async () => {
    const tool: GeneratedTool = {
      id: 'tool-1',
      name: 'test_tool',
      description: 'Test',
      implementation: 'async function execute() {}',
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'active',
    };

    await store.save(tool);
    const retrieved = await store.get('tool-1');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe('test_tool');
  });

  it('lists tools by status', async () => {
    await store.save({
      id: 'tool-1',
      name: 'active_tool',
      description: 'Active',
      implementation: '',
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'active',
    });

    await store.save({
      id: 'tool-2',
      name: 'pending_tool',
      description: 'Pending',
      implementation: '',
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
    });

    const activeTools = await store.list({ status: 'active' });
    expect(activeTools).toHaveLength(1);
    expect(activeTools[0].name).toBe('active_tool');
  });

  it('records usage and calculates metrics', async () => {
    await store.save({
      id: 'tool-1',
      name: 'used_tool',
      description: 'Used',
      implementation: '',
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'active',
    });

    await store.recordUsage({
      toolId: 'tool-1',
      timestamp: new Date(),
      success: true,
      executionTime: 100,
    });
    await store.recordUsage({
      toolId: 'tool-1',
      timestamp: new Date(),
      success: true,
      executionTime: 150,
    });
    await store.recordUsage({
      toolId: 'tool-1',
      timestamp: new Date(),
      success: false,
      executionTime: 200,
    });

    const metrics = await store.getMetrics('tool-1');

    expect(metrics).not.toBeNull();
    expect(metrics?.totalUsage).toBe(3);
    expect(metrics?.successRate).toBeCloseTo(0.666, 2);
    expect(metrics?.averageExecutionTime).toBe(150);
  });

  it('finds similar tools', async () => {
    await store.save({
      id: 'tool-1',
      name: 'csv_parser',
      description: 'Parse CSV files into JSON',
      implementation: '',
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'active',
    });

    await store.save({
      id: 'tool-2',
      name: 'json_formatter',
      description: 'Format JSON data',
      implementation: '',
      parameters: { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'active',
    });

    const similar = await store.findSimilar('parse csv data');
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].name).toBe('csv_parser');
  });
});

describe('Parsing functions', () => {
  it('parses gap analysis response', () => {
    const response = `
    Based on analysis:
    {
      "hasGap": true,
      "gaps": [
        {
          "id": "gap-1",
          "description": "Need image processing",
          "requiredCapability": "Process images",
          "suggestedToolName": "image_processor",
          "complexity": "moderate",
          "confidence": 0.85,
          "reasoning": "No existing image tools"
        }
      ],
      "canProceed": false
    }
    `;

    const parsed = parseGapAnalysisResponse(response);

    expect(parsed.hasGap).toBe(true);
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0].suggestedToolName).toBe('image_processor');
  });

  it('parses tool generation response', () => {
    const response = `
    Here's the tool:
    {
      "name": "calculator",
      "description": "Perform arithmetic operations",
      "implementation": "async function execute(p) { return p.a + p.b; }",
      "parameters": { "type": "object", "properties": {} },
      "reasoning": "Simple calculator implementation"
    }
    `;

    const parsed = parseToolGenerationResponse(response);

    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('calculator');
  });
});
