import type {
  GeneratedTool,
  ToolValidationResult,
  LLMBackend,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import { ToolSandbox, type SandboxTestCase } from './tool-sandbox';
import { buildToolValidationPrompt, parseValidationResponse, type ToolReview } from './prompts';
import { llmChat, requireModelForLLM } from '../utils/llm-helper';

export interface ToolValidatorOptions {
  llm?: LLMBackend;
  config: ToolSelfGenerationConfig;
  model?: string;
  /** Upper bound on the output tokens of the review call. Unset leaves the backend default. */
  maxTokens?: number;
}

interface JsonPropertySchema {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  examples?: unknown[];
}

export interface ValidationRule {
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
      if (/(?<![.\w$])exec\s*\(/.test(code)) return 'Uses exec()';
      if (/\bspawn(?:Sync)?\s*\(/.test(code)) return 'Uses spawn()';
      if (/\bexec(?:Sync|File|FileSync)\s*\(/.test(code)) return 'Uses execSync()/execFile()';
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

/** Edge cases and approved review notes lower the score, but never below a passing grade on their own. */
const MAX_ADVISORY_PENALTY = 0.3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primaryType(type: JsonPropertySchema['type']): string | undefined {
  return Array.isArray(type) ? type.find((t) => t !== 'null') : type;
}

function matchesType(value: unknown, type: JsonPropertySchema['type']): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number' && Number.isFinite(value);
      case 'integer':
        return Number.isInteger(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return isRecord(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  });
}

/** Whether an input has every required parameter, no unknown one, and values of the declared types. */
function fitsSchema(input: Record<string, unknown>, parameters: Record<string, unknown>): boolean {
  const properties = isRecord(parameters.properties)
    ? (parameters.properties as Record<string, JsonPropertySchema>)
    : {};
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  if (required.some((key) => typeof key === 'string' && !(key in input))) return false;
  if (Object.keys(properties).length === 0) return true;

  return Object.entries(input).every(([key, value]) => {
    const schema = properties[key];
    return schema !== undefined && matchesType(value, schema.type);
  });
}

/** A review approves when it calls the tool valid and does not ask for a revision or a rejection. */
function approves(review: ToolReview): boolean {
  return review.isValid && (review.recommendation ?? 'approve') === 'approve';
}

export class ToolValidator {
  private readonly llm?: LLMBackend;
  private readonly config: ToolSelfGenerationConfig;
  private readonly model: string;
  private readonly maxTokens?: number;
  private readonly sandbox: ToolSandbox;
  private readonly customRules: ValidationRule[] = [];

  constructor(options: ToolValidatorOptions) {
    this.llm = options.llm;
    this.maxTokens = options.maxTokens;
    this.config = options.config;
    this.model = requireModelForLLM(options.llm, options.model, 'ToolValidator');
    this.sandbox = new ToolSandbox(options.config.sandboxConfig);
  }

  /**
   * Grades a tool. Static security checks and sandbox test failures are authoritative: either
   * makes the tool invalid whatever a review says. When `requireLLMValidation` is on, the
   * reviewer's verdict decides the rest: an approving review keeps its security and logic
   * notes as suggestions, while a review that recommends a revision or rejects the tool makes
   * it invalid and its findings become the issues to fix.
   *
   * Without `testCases`, the tool runs on the example inputs it was generated with (they must
   * succeed) and on inputs synthesized from its parameters schema (they only prove the tool
   * runs: a descriptive error is accepted).
   */
  async validate(
    tool: GeneratedTool,
    testCases?: SandboxTestCase[]
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

    const effectiveTestCases = testCases ?? [
      ...this.exampleTestCases(tool),
      ...this.generateBasicTestCases(tool),
    ];
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

    let advisoryNotes = 0;
    if (this.llm && this.config.requireLLMValidation) {
      const review = await this.runLLMValidation(tool, effectiveTestCases);
      if (review) {
        edgeCases.push(...review.edgeCases);
        suggestions.push(...review.suggestions);

        if (approves(review)) {
          const notes = [
            ...review.securityIssues.map((issue) => `Review note (security): ${issue}`),
            ...review.logicIssues.map((issue) => `Review note (logic): ${issue}`),
          ];
          advisoryNotes = notes.length;
          suggestions.push(...notes);
        } else {
          securityIssues.push(...review.securityIssues);
          logicIssues.push(...review.logicIssues);
          if (review.securityIssues.length === 0 && review.logicIssues.length === 0) {
            logicIssues.push(
              `The review recommends to ${review.recommendation ?? 'reject'} the tool without naming an issue: check it against its description`
            );
          }
        }
      }
    }

    const score = this.calculateScore(
      securityIssues.length,
      logicIssues.length,
      edgeCases.length + advisoryNotes,
      sandboxResult.passed,
      sandboxResult.failed
    );

    return {
      isValid: securityIssues.length === 0 && logicIssues.length === 0,
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
        } else {
          warnings.push(`[${rule.id}] ${result}`);
        }
      }
    }

    return { errors, warnings };
  }

  private async runLLMValidation(
    tool: GeneratedTool,
    testCases: SandboxTestCase[]
  ): Promise<ToolReview | null> {
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
              : tc.allowThrow
                ? 'Should either return a result or throw a descriptive error'
                : 'Should execute successfully',
        }))
      );

      const content = await llmChat(
        this.llm,
        [
          {
            role: 'system',
            content: `You are a security auditor and code reviewer.
Analyze code for security vulnerabilities, logic errors, and edge cases.
Be thorough but practical - focus on real issues.`,
          },
          { role: 'user', content: prompt },
        ],
        { model: this.model, temperature: 0.2, maxTokens: this.maxTokens }
      );

      return parseValidationResponse(content);
    } catch {
      return null;
    }
  }

  /** The example inputs the tool was generated with that fit its schema, as cases that must succeed. */
  private exampleTestCases(tool: GeneratedTool): SandboxTestCase[] {
    const examples = tool.metadata?.examples;
    if (!Array.isArray(examples)) return [];

    return examples.flatMap((example: unknown) => {
      if (!isRecord(example) || !isRecord(example.input)) return [];
      return fitsSchema(example.input, tool.parameters) ? [{ input: example.input }] : [];
    });
  }

  private generateBasicTestCases(tool: GeneratedTool): SandboxTestCase[] {
    const params = tool.parameters;

    if (params.type !== 'object' || !params.properties || typeof params.properties !== 'object') {
      return [{ input: {} }];
    }

    const properties = params.properties as Record<string, JsonPropertySchema>;
    const required = new Set(
      Array.isArray(params.required)
        ? params.required.filter((r): r is string => typeof r === 'string')
        : []
    );
    const entries = Object.entries(properties);
    const testCases: SandboxTestCase[] = [];

    const sampleInput: Record<string, unknown> = {};
    for (const [key, schema] of entries) {
      sampleInput[key] = this.generateSampleValue(schema);
    }
    testCases.push({ input: sampleInput, allowThrow: true });

    const hasOptional = entries.some(([key]) => !required.has(key));
    if (required.size > 0 && hasOptional) {
      const requiredOnlyInput: Record<string, unknown> = {};
      for (const [key, schema] of entries) {
        if (required.has(key)) {
          requiredOnlyInput[key] = this.generateSampleValue(schema);
        }
      }
      testCases.push({ input: requiredOnlyInput, allowThrow: true });
    }

    const edgeInput: Record<string, unknown> = {};
    for (const [key, schema] of entries) {
      edgeInput[key] = this.generateEdgeValue(primaryType(schema.type));
    }
    testCases.push({ input: edgeInput, allowThrow: true });

    if (required.size > 0) {
      const missingRequired: Record<string, unknown> = {};
      for (const [key, schema] of entries) {
        if (!required.has(key)) {
          missingRequired[key] = this.generateSampleValue(schema);
        }
      }
      testCases.push({ input: missingRequired, shouldThrow: true });
    }

    return testCases;
  }

  private generateSampleValue(schema: JsonPropertySchema): unknown {
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

    switch (primaryType(schema.type)) {
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

  private generateEdgeValue(type?: string): unknown {
    switch (type) {
      case 'string':
        return '';
      case 'number':
        return 0;
      case 'integer':
        return -1;
      case 'boolean':
        return false;
      case 'array':
        return [null, 0, ''];
      case 'object':
        return { unexpected: true };
      default:
        return undefined;
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
    score -= Math.min(MAX_ADVISORY_PENALTY, edgeCaseCount * 0.05);

    const totalTests = testsPassed + testsFailed;
    if (totalTests > 0) {
      const testScore = testsPassed / totalTests;
      score = score * 0.6 + testScore * 0.4;
    }

    return Math.max(0, Math.min(1, score));
  }
}
