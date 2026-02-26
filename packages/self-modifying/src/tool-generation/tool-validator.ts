import type {
  GeneratedTool,
  ToolValidationResult,
  LLMBackend,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import { ToolSandbox } from './tool-sandbox';
import { buildToolValidationPrompt, parseValidationResponse } from './prompts';

export interface ToolValidatorOptions {
  llm?: LLMBackend;
  config: ToolSelfGenerationConfig;
  model?: string;
}

interface ValidationRule {
  id: string;
  name: string;
  severity: 'error' | 'warning' | 'info';
  check: (code: string, tool: GeneratedTool) => string | null;
}

const STATIC_VALIDATION_RULES: ValidationRule[] = [
  {
    id: 'no_eval',
    name: 'No eval() or Function constructor',
    severity: 'error',
    check: (code) => {
      if (/\beval\s*\(/.test(code)) return 'Uses eval()';
      if (/\bnew\s+Function\s*\(/.test(code)) return 'Uses Function constructor';
      return null;
    },
  },
  {
    id: 'no_dynamic_import',
    name: 'No dynamic imports',
    severity: 'error',
    check: (code) => {
      if (/\bimport\s*\(/.test(code)) return 'Uses dynamic import()';
      if (/\brequire\s*\(/.test(code)) return 'Uses require()';
      return null;
    },
  },
  {
    id: 'no_global_access',
    name: 'No global object access',
    severity: 'error',
    check: (code) => {
      if (/\bprocess\./.test(code)) return 'Accesses process object';
      if (/\bglobal\./.test(code)) return 'Accesses global object';
      if (/\bglobalThis\./.test(code)) return 'Accesses globalThis';
      return null;
    },
  },
  {
    id: 'no_prototype_pollution',
    name: 'No prototype pollution',
    severity: 'error',
    check: (code) => {
      if (code.includes('__proto__')) return 'Uses __proto__';
      if (/\.prototype\s*=/.test(code)) return 'Modifies prototype';
      if (code.includes('Object.setPrototypeOf')) return 'Uses setPrototypeOf';
      return null;
    },
  },
  {
    id: 'no_infinite_loops',
    name: 'No obvious infinite loops',
    severity: 'warning',
    check: (code) => {
      if (/while\s*\(\s*true\s*\)/.test(code) && !code.includes('break')) {
        return 'Contains while(true) without break';
      }
      if (/for\s*\(\s*;\s*;\s*\)/.test(code) && !code.includes('break')) {
        return 'Contains for(;;) without break';
      }
      return null;
    },
  },
  {
    id: 'has_execute_function',
    name: 'Has execute function',
    severity: 'error',
    check: (code) => {
      const patterns = [
        /(?:async\s+)?function\s+execute\s*\(/,
        /const\s+execute\s*=\s*(?:async\s*)?\(/,
        /const\s+execute\s*=\s*(?:async\s+)?function/,
        /let\s+execute\s*=\s*(?:async\s*)?\(/,
        /execute\s*=\s*(?:async\s*)?\(/,
      ];
      const hasExecute = patterns.some((p) => p.test(code));
      return hasExecute ? null : 'Missing execute function';
    },
  },
  {
    id: 'reasonable_length',
    name: 'Reasonable code length',
    severity: 'warning',
    check: (code) => {
      const lines = code.split('\n').length;
      if (lines > 150) return `Too long: ${lines} lines (recommended < 150)`;
      return null;
    },
  },
  {
    id: 'no_shell_commands',
    name: 'No shell command execution',
    severity: 'error',
    check: (code) => {
      if (code.includes('child_process')) return 'Uses child_process';
      if (/\bexec\s*\(/.test(code)) return 'Uses exec()';
      if (/\bspawn\s*\(/.test(code)) return 'Uses spawn()';
      if (/\bexecSync\s*\(/.test(code)) return 'Uses execSync()';
      return null;
    },
  },
  {
    id: 'no_file_system',
    name: 'No file system access',
    severity: 'error',
    check: (code) => {
      if (/\bfs\./.test(code)) return 'Uses fs module';
      if (/readFileSync|writeFileSync/.test(code)) return 'Uses file system sync methods';
      if (/readFile|writeFile/.test(code)) return 'Uses file system methods';
      return null;
    },
  },
  {
    id: 'has_error_handling',
    name: 'Has error handling',
    severity: 'info',
    check: (code) => {
      if (!/try\s*\{/.test(code) && !/\.catch\s*\(/.test(code)) {
        return 'No try-catch or .catch() error handling';
      }
      return null;
    },
  },
];

export class ToolValidator {
  private readonly llm?: LLMBackend;
  private readonly config: ToolSelfGenerationConfig;
  private readonly model: string;
  private readonly sandbox: ToolSandbox;
  private readonly customRules: ValidationRule[] = [];

  constructor(options: ToolValidatorOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.model = options.model ?? 'default';
    this.sandbox = new ToolSandbox(options.config.sandboxConfig);
  }

  async validate(
    tool: GeneratedTool,
    testCases?: Array<{ input: unknown; expectedOutput?: unknown; shouldThrow?: boolean }>
  ): Promise<ToolValidationResult> {
    const securityIssues: string[] = [];
    const logicIssues: string[] = [];
    const edgeCases: string[] = [];
    const suggestions: string[] = [];

    const staticResult = this.runStaticAnalysis(tool);
    securityIssues.push(...staticResult.errors);
    suggestions.push(...staticResult.warnings);

    if (securityIssues.length > 0) {
      return {
        isValid: false,
        securityIssues,
        logicIssues,
        edgeCases,
        suggestions,
        testResults: [],
        overallScore: 0,
      };
    }

    const effectiveTestCases = testCases || this.generateBasicTestCases(tool);
    const sandboxResult = await this.sandbox.testWithCases(tool, effectiveTestCases);

    const testResults = sandboxResult.results.map((r) => ({
      input: r.input,
      output: r.output,
      passed: r.passed,
      error: r.error,
    }));

    if (sandboxResult.failed > 0) {
      const failedTests = sandboxResult.results.filter((r) => !r.passed);
      logicIssues.push(
        ...failedTests.map(
          (t) =>
            `Test failed for input ${JSON.stringify(t.input)}: ${t.error || 'unexpected output'}`
        )
      );
    }

    if (this.llm && this.config.requireLLMValidation) {
      const llmResult = await this.runLLMValidation(tool, effectiveTestCases);
      if (llmResult) {
        securityIssues.push(...llmResult.securityIssues);
        logicIssues.push(...llmResult.logicIssues);
        edgeCases.push(...llmResult.edgeCases);
        suggestions.push(...llmResult.suggestions);
      }
    }

    const score = this.calculateScore(
      securityIssues.length,
      logicIssues.length,
      edgeCases.length,
      sandboxResult.passed,
      sandboxResult.failed
    );

    return {
      isValid: securityIssues.length === 0 && logicIssues.length === 0 && score >= 0.7,
      securityIssues: [...new Set(securityIssues)],
      logicIssues: [...new Set(logicIssues)],
      edgeCases: [...new Set(edgeCases)],
      suggestions: [...new Set(suggestions)],
      testResults,
      overallScore: score,
    };
  }

  addRule(rule: ValidationRule): void {
    this.customRules.push(rule);
  }

  private runStaticAnalysis(tool: GeneratedTool): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const allRules = [...STATIC_VALIDATION_RULES, ...this.customRules];

    for (const rule of allRules) {
      const result = rule.check(tool.implementation, tool);
      if (result) {
        if (rule.severity === 'error') {
          errors.push(`[${rule.id}] ${result}`);
        } else if (rule.severity === 'warning') {
          warnings.push(`[${rule.id}] ${result}`);
        }
      }
    }

    return { errors, warnings };
  }

  private async runLLMValidation(
    tool: GeneratedTool,
    testCases: Array<{ input: unknown; expectedOutput?: unknown; shouldThrow?: boolean }>
  ): Promise<ToolValidationResult | null> {
    if (!this.llm) return null;

    try {
      const prompt = buildToolValidationPrompt(
        tool,
        testCases.map((tc) => ({
          input: tc.input,
          expectedBehavior: tc.expectedOutput
            ? `Should return ${JSON.stringify(tc.expectedOutput)}`
            : tc.shouldThrow
              ? 'Should throw an error'
              : 'Should execute successfully',
        }))
      );

      const response = await this.callLLM(
        [
          {
            role: 'system',
            content: `You are a security auditor and code reviewer.
Analyze code for security vulnerabilities, logic errors, and edge cases.
Be thorough but practical - focus on real issues.`,
          },
          { role: 'user', content: prompt },
        ],
        0.2
      );

      return response ? parseValidationResponse(response.content) : null;
    } catch {
      return null;
    }
  }

  private generateBasicTestCases(
    tool: GeneratedTool
  ): Array<{ input: unknown; expectedOutput?: unknown; shouldThrow?: boolean }> {
    const testCases: Array<{ input: unknown; expectedOutput?: unknown; shouldThrow?: boolean }> =
      [];
    const params = tool.parameters;

    if (params.type === 'object' && params.properties) {
      const validInput: Record<string, unknown> = {};
      const properties = params.properties as Record<string, { type?: string; default?: unknown }>;

      for (const [key, schema] of Object.entries(properties)) {
        validInput[key] = this.generateSampleValue(schema.type, schema.default);
      }
      testCases.push({ input: validInput });
    }

    return testCases;
  }

  private generateSampleValue(type?: string, defaultValue?: unknown): unknown {
    if (defaultValue !== undefined) return defaultValue;

    switch (type) {
      case 'string':
        return 'test';
      case 'number':
      case 'integer':
        return 42;
      case 'boolean':
        return true;
      case 'array':
        return [];
      case 'object':
        return {};
      default:
        return null;
    }
  }

  private calculateScore(
    securityCount: number,
    logicCount: number,
    edgeCaseCount: number,
    testsPassed: number,
    testsFailed: number
  ): number {
    if (securityCount > 0) return 0;

    let score = 1.0;

    score -= logicCount * 0.2;
    score -= edgeCaseCount * 0.05;

    const totalTests = testsPassed + testsFailed;
    if (totalTests > 0) {
      const testScore = testsPassed / totalTests;
      score = score * 0.6 + testScore * 0.4;
    }

    return Math.max(0, Math.min(1, score));
  }

  private async callLLM(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: number
  ) {
    if (!this.llm) return null;
    if (this.llm.complete) {
      return this.llm.complete({ messages, temperature });
    }
    return this.llm.chat({ model: this.model, messages, temperature });
  }
}
