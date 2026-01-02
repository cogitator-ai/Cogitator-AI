import type { ToolSandboxConfig, ToolSandboxResult, GeneratedTool } from '@cogitator-ai/types';

export const DEFAULT_SANDBOX_CONFIG: ToolSandboxConfig = {
  enabled: true,
  maxExecutionTime: 5000,
  maxMemory: 50 * 1024 * 1024,
  allowedModules: [],
  isolationLevel: 'strict',
};

interface SandboxContext {
  console: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  Math: typeof Math;
  JSON: typeof JSON;
  Date: typeof Date;
  Array: typeof Array;
  Object: typeof Object;
  String: typeof String;
  Number: typeof Number;
  Boolean: typeof Boolean;
  RegExp: typeof RegExp;
  Map: typeof Map;
  Set: typeof Set;
  Promise: typeof Promise;
  Error: typeof Error;
  TypeError: typeof TypeError;
  RangeError: typeof RangeError;
}

export class ToolSandbox {
  private readonly config: ToolSandboxConfig;
  private readonly logs: string[] = [];

  constructor(config: Partial<ToolSandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  async execute(tool: GeneratedTool, params: unknown): Promise<ToolSandboxResult> {
    const startTime = Date.now();
    this.logs.length = 0;

    if (!this.config.enabled) {
      return this.executeUnsandboxed(tool, params, startTime);
    }

    try {
      this.validateImplementation(tool.implementation);

      const context = this.createContext();
      const wrappedCode = this.wrapImplementation(tool.implementation);

      const result = await this.executeWithTimeout(
        wrappedCode,
        context,
        params,
        this.config.maxExecutionTime
      );

      return {
        success: true,
        result,
        executionTime: Date.now() - startTime,
        memoryUsed: this.estimateMemoryUsage(result),
        logs: [...this.logs],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        memoryUsed: 0,
        logs: [...this.logs],
      };
    }
  }

  async testWithCases(
    tool: GeneratedTool,
    testCases: Array<{ input: unknown; expectedOutput?: unknown; shouldThrow?: boolean }>
  ): Promise<{
    passed: number;
    failed: number;
    results: Array<{
      input: unknown;
      output?: unknown;
      error?: string;
      passed: boolean;
      executionTime: number;
    }>;
  }> {
    const results: Array<{
      input: unknown;
      output?: unknown;
      error?: string;
      passed: boolean;
      executionTime: number;
    }> = [];

    for (const testCase of testCases) {
      const execResult = await this.execute(tool, testCase.input);

      let passed = false;
      if (testCase.shouldThrow) {
        passed = !execResult.success;
      } else if (testCase.expectedOutput !== undefined) {
        passed = execResult.success && this.deepEqual(execResult.result, testCase.expectedOutput);
      } else {
        passed = execResult.success;
      }

      results.push({
        input: testCase.input,
        output: execResult.result,
        error: execResult.error,
        passed,
        executionTime: execResult.executionTime,
      });
    }

    return {
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };
  }

  private validateImplementation(code: string): void {
    const forbidden = [
      /\beval\s*\(/,
      /\bFunction\s*\(/,
      /\bnew\s+Function\s*\(/,
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /\bprocess\./,
      /\bglobal\./,
      /\bglobalThis\./,
      /\bwindow\./,
      /\bdocument\./,
      /\bchild_process/,
      /\bfs\./,
      /\bhttp\./,
      /\bhttps\./,
      /\bnet\./,
      /\bdns\./,
      /\bos\./,
      /\bexec\s*\(/,
      /\bspawn\s*\(/,
      /__proto__/,
      /\bconstructor\s*\[/,
    ];

    if (this.config.isolationLevel === 'strict') {
      forbidden.push(
        /\bfetch\s*\(/,
        /\bXMLHttpRequest/,
        /\bWebSocket/,
        /\bsetTimeout\s*\(/,
        /\bsetInterval\s*\(/
      );
    }

    for (const pattern of forbidden) {
      if (pattern.test(code)) {
        throw new Error(`Security violation: forbidden pattern detected - ${pattern.source}`);
      }
    }

    const lines = code.split('\n').length;
    if (lines > 200) {
      throw new Error(`Implementation too large: ${lines} lines (max 200)`);
    }
  }

  private createContext(): SandboxContext {
    return {
      console: {
        log: (...args: unknown[]) => {
          this.logs.push(`[LOG] ${args.map(String).join(' ')}`);
        },
        warn: (...args: unknown[]) => {
          this.logs.push(`[WARN] ${args.map(String).join(' ')}`);
        },
        error: (...args: unknown[]) => {
          this.logs.push(`[ERROR] ${args.map(String).join(' ')}`);
        },
      },
      Math,
      JSON,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      Promise,
      Error,
      TypeError,
      RangeError,
    };
  }

  private wrapImplementation(code: string): string {
    return `
      "use strict";
      return (async function sandboxedExecution(params, context) {
        const { console, Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise, Error, TypeError, RangeError } = context;

        ${code}

        if (typeof execute === 'function') {
          return await execute(params);
        }
        throw new Error('Implementation must define an execute function');
      });
    `;
  }

  private async executeWithTimeout(
    wrappedCode: string,
    context: SandboxContext,
    params: unknown,
    timeout: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Execution timeout: exceeded ${timeout}ms`));
      }, timeout);

      try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const factory = new Function(wrappedCode);
        const executor = factory();

        Promise.resolve(executor(params, context))
          .then((result) => {
            clearTimeout(timer);
            resolve(result);
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async executeUnsandboxed(
    tool: GeneratedTool,
    params: unknown,
    startTime: number
  ): Promise<ToolSandboxResult> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const factory = new Function(`
        "use strict";
        ${tool.implementation}
        return execute;
      `);
      const execute = factory();
      const result = await execute(params);

      return {
        success: true,
        result,
        executionTime: Date.now() - startTime,
        memoryUsed: this.estimateMemoryUsage(result),
        logs: [],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        memoryUsed: 0,
        logs: [],
      };
    }
  }

  private estimateMemoryUsage(value: unknown): number {
    try {
      const str = JSON.stringify(value);
      return str.length * 2;
    } catch {
      return 0;
    }
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, i) => this.deepEqual(val, b[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;
      const keysA = Object.keys(aObj);
      const keysB = Object.keys(bObj);

      if (keysA.length !== keysB.length) return false;
      return keysA.every((key) => this.deepEqual(aObj[key], bObj[key]));
    }

    return false;
  }
}
