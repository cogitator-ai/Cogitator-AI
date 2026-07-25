import { Worker } from 'node:worker_threads';
import type { ToolSandboxConfig, ToolSandboxResult, GeneratedTool } from '@cogitator-ai/types';

export const DEFAULT_SANDBOX_CONFIG: ToolSandboxConfig = {
  enabled: true,
  maxExecutionTime: 5000,
  maxMemory: 50 * 1024 * 1024,
  allowedModules: [],
  isolationLevel: 'strict',
};

const WORKER_SOURCE = [
  'const { parentPort, workerData } = require("worker_threads");',
  'const vm = require("vm");',
  'const { code, params } = workerData;',
  'const logs = [];',
  'const sandbox = Object.create(null);',
  'Object.assign(sandbox, {',
  '  console: {',
  '    log: (...a) => { logs.push("[LOG] " + a.map(String).join(" ")); },',
  '    warn: (...a) => { logs.push("[WARN] " + a.map(String).join(" ")); },',
  '    error: (...a) => { logs.push("[ERROR] " + a.map(String).join(" ")); },',
  '  },',
  '  Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set,',
  '  Promise, Error, TypeError, RangeError,',
  '  parseInt, parseFloat, isNaN, isFinite,',
  '  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,',
  '  undefined, NaN, Infinity,',
  '  params,',
  '});',
  'const context = vm.createContext(sandbox);',
  'try {',
  '  const wrapped = "(async function sandboxedExecution() {\\n" +',
  '    code + "\\n" +',
  '    "if (typeof execute === \\"function\\") { return await execute(params); }\\n" +',
  '    "throw new Error(\\"Implementation must define an execute function\\");\\n" +',
  '    "})()";',
  '  const promise = vm.runInContext(wrapped, context);',
  '  Promise.resolve(promise).then(',
  '    (result) => { parentPort.postMessage({ success: true, result, logs }); },',
  '    (err) => { parentPort.postMessage({ success: false, error: err instanceof Error ? err.message : String(err), logs }); }',
  '  );',
  '} catch (err) {',
  '  parentPort.postMessage({ success: false, error: err instanceof Error ? err.message : String(err), logs });',
  '}',
].join('\n');

export class ToolSandbox {
  private readonly config: ToolSandboxConfig;

  constructor(config: Partial<ToolSandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  async execute(tool: GeneratedTool, params: unknown): Promise<ToolSandboxResult> {
    const startTime = Date.now();

    try {
      this.validateImplementation(tool.implementation);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTime: Date.now() - startTime,
        memoryUsed: 0,
        logs: [],
      };
    }

    if (!this.config.enabled) {
      return this.executeUnsandboxed(tool, params, startTime);
    }

    return this.executeInWorker(tool.implementation, params, startTime);
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
        passed = execResult.success && deepEqual(execResult.result, testCase.expectedOutput);
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
    const forbidden: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /\beval\s*\(/, label: 'eval()' },
      { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
      { pattern: /\bFunction\s*\.\s*prototype/, label: 'Function.prototype' },
      { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
      { pattern: /\brequire\s*\(/, label: 'require()' },
      { pattern: /\bprocess\s*[\[.]/, label: 'process access' },
      { pattern: /\bglobal\s*[\[.]/, label: 'global access' },
      { pattern: /\bglobalThis\s*[\[.]/, label: 'globalThis access' },
      { pattern: /\bwindow\s*[\[.]/, label: 'window access' },
      { pattern: /\bdocument\s*[\[.]/, label: 'document access' },
      { pattern: /\bchild_process\b/, label: 'child_process' },
      { pattern: /\brequire\s*\(\s*['"]fs['"]/, label: 'fs module' },
      { pattern: /\brequire\s*\(\s*['"]net['"]/, label: 'net module' },
      { pattern: /\brequire\s*\(\s*['"]dns['"]/, label: 'dns module' },
      { pattern: /\brequire\s*\(\s*['"]http['"]/, label: 'http module' },
      { pattern: /\brequire\s*\(\s*['"]https['"]/, label: 'https module' },
      { pattern: /\brequire\s*\(\s*['"]os['"]/, label: 'os module' },
      { pattern: /\bspawn\s*\(/, label: 'spawn()' },
      { pattern: /\bexecSync\s*\(/, label: 'execSync()' },
      { pattern: /\bexecFile\s*\(/, label: 'execFile()' },
      { pattern: /__proto__/, label: '__proto__' },
      { pattern: /\.\s*constructor\s*[\[.(]/, label: 'constructor access' },
      { pattern: /\bgetPrototypeOf\s*\(/, label: 'getPrototypeOf()' },
      { pattern: /\bsetPrototypeOf\s*\(/, label: 'setPrototypeOf()' },
      { pattern: /\bReflect\s*[\[.]/, label: 'Reflect access' },
      { pattern: /\bProxy\s*[\[.(]/, label: 'Proxy access' },
      { pattern: /\bSymbol\s*\.\s*for\s*\(/, label: 'Symbol.for()' },
      { pattern: /\bSharedArrayBuffer\b/, label: 'SharedArrayBuffer' },
      { pattern: /\bAtomics\b/, label: 'Atomics' },
      { pattern: /\bWeakRef\b/, label: 'WeakRef' },
      { pattern: /\bFinalizationRegistry\b/, label: 'FinalizationRegistry' },
    ];

    if (this.config.isolationLevel === 'strict') {
      forbidden.push(
        { pattern: /\bfetch\s*\(/, label: 'fetch()' },
        { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
        { pattern: /\bWebSocket\b/, label: 'WebSocket' },
        { pattern: /\bsetTimeout\s*\(/, label: 'setTimeout()' },
        { pattern: /\bsetInterval\s*\(/, label: 'setInterval()' }
      );
    }

    for (const { pattern, label } of forbidden) {
      if (pattern.test(code)) {
        throw new Error(`Security violation: forbidden pattern detected - ${label}`);
      }
    }

    const bracketGlobalAccess = /\b(?:global|globalThis|process|window|document)\s*\[\s*['"`]/;
    if (bracketGlobalAccess.test(code)) {
      throw new Error('Security violation: bracket notation access to global objects');
    }

    const stringConcatEscape = /['"`]\s*\+\s*['"`]/;
    if (stringConcatEscape.test(code)) {
      const concatenated = code.replace(/['"`]\s*\+\s*['"`]/g, '');
      for (const { pattern, label } of forbidden) {
        if (pattern.test(concatenated)) {
          throw new Error(`Security violation: obfuscated forbidden pattern detected - ${label}`);
        }
      }
    }

    const lines = code.split('\n').length;
    if (lines > 200) {
      throw new Error(`Implementation too large: ${lines} lines (max 200)`);
    }
  }

  private async executeInWorker(
    code: string,
    params: unknown,
    startTime: number
  ): Promise<ToolSandboxResult> {
    let serializableParams: unknown;
    try {
      serializableParams = JSON.parse(JSON.stringify(params ?? null));
    } catch {
      serializableParams = null;
    }

    return new Promise<ToolSandboxResult>((resolve) => {
      let settled = false;

      const settle = (result: ToolSandboxResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      const maxMemoryMb = Math.max(4, Math.ceil(this.config.maxMemory / (1024 * 1024)));

      let worker: Worker;
      try {
        worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { code, params: serializableParams },
          resourceLimits: {
            maxOldGenerationSizeMb: maxMemoryMb,
            maxYoungGenerationSizeMb: Math.max(2, Math.ceil(maxMemoryMb / 4)),
          },
        });
      } catch (error) {
        settle({
          success: false,
          error: `Failed to create sandbox worker: ${error instanceof Error ? error.message : String(error)}`,
          executionTime: Date.now() - startTime,
          memoryUsed: 0,
          logs: [],
        });
        return;
      }

      const timer = setTimeout(() => {
        void worker.terminate();
        settle({
          success: false,
          error: `Execution timeout: exceeded ${this.config.maxExecutionTime}ms`,
          executionTime: Date.now() - startTime,
          memoryUsed: 0,
          logs: [],
        });
      }, this.config.maxExecutionTime);

      worker.on(
        'message',
        (msg: { success: boolean; result?: unknown; error?: string; logs?: string[] }) => {
          clearTimeout(timer);
          settle({
            success: msg.success,
            result: msg.result,
            error: msg.error,
            executionTime: Date.now() - startTime,
            memoryUsed: estimateMemoryUsage(msg.result),
            logs: msg.logs ?? [],
          });
        }
      );

      worker.on('error', (error: Error) => {
        clearTimeout(timer);
        settle({
          success: false,
          error: `Sandbox worker error: ${error.message}`,
          executionTime: Date.now() - startTime,
          memoryUsed: 0,
          logs: [],
        });
      });

      worker.on('exit', (exitCode: number) => {
        clearTimeout(timer);
        if (exitCode !== 0) {
          settle({
            success: false,
            error:
              exitCode === 134 || exitCode === 137
                ? `Execution exceeded memory limit (${this.config.maxMemory} bytes)`
                : `Sandbox worker exited with code ${exitCode}`,
            executionTime: Date.now() - startTime,
            memoryUsed: 0,
            logs: [],
          });
        }
      });
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

      const result = await Promise.race([
        execute(params),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error(`Execution timeout: exceeded ${this.config.maxExecutionTime}ms`)),
            this.config.maxExecutionTime
          )
        ),
      ]);

      return {
        success: true,
        result,
        executionTime: Date.now() - startTime,
        memoryUsed: estimateMemoryUsage(result),
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
}

function estimateMemoryUsage(value: unknown): number {
  try {
    const str = JSON.stringify(value);
    return str ? str.length * 2 : 0;
  } catch {
    return 0;
  }
}

export function deepEqual(a: unknown, b: unknown, seen = new WeakSet<object>()): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || !deepEqual(val, b.get(key), seen)) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const val of a) {
      if (!b.has(val)) return false;
    }
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i], seen));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    if (seen.has(aObj) || seen.has(bObj)) return false;
    seen.add(aObj);
    seen.add(bObj);

    const keysA = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
    const keysB = Object.keys(bObj).filter((k) => bObj[k] !== undefined);

    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqual(aObj[key], bObj[key], seen));
  }

  return false;
}
