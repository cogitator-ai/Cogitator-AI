import { Worker } from 'node:worker_threads';
import type { ToolSandboxConfig, ToolSandboxResult, GeneratedTool } from '@cogitator-ai/types';

export const DEFAULT_SANDBOX_CONFIG: ToolSandboxConfig = {
  enabled: true,
  maxExecutionTime: 5000,
  maxMemory: 50 * 1024 * 1024,
  allowedModules: [],
  isolationLevel: 'strict',
};

/**
 * How long a sandbox worker may take to boot. `maxExecutionTime` starts counting only once the
 * worker is online, so a slow or loaded machine does not eat into the tool's own time budget.
 */
const WORKER_STARTUP_TIMEOUT_MS = 10_000;

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { code, paramsJson, timeout } = workerData;

const BOOTSTRAP = [
  '(function () {',
  '  "use strict";',
  '  const logs = [];',
  '  const format = (args) => args.map((v) => {',
  '    if (typeof v === "string") return v;',
  '    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }',
  '  }).join(" ");',
  '  const logger = (level) => (...args) => { if (logs.length < 1000) logs.push("[" + level + "] " + format(args)); };',
  '  Object.defineProperty(globalThis, "console", { value: Object.freeze({',
  '    log: logger("LOG"), info: logger("INFO"), debug: logger("DEBUG"), warn: logger("WARN"), error: logger("ERROR"),',
  '  }) });',
  '  Object.defineProperty(globalThis, "__sandboxState", { value: { status: "pending", payload: "", hasValue: false, logs } });',
  '})();',
].join('\n');

const runner = [
  '(async function sandboxedExecution(params) {',
  code,
  '  if (typeof execute !== "function") { throw new Error("Implementation must define an execute function"); }',
  '  return await execute(params);',
  '})(JSON.parse(' + JSON.stringify(paramsJson) + ')).then(',
  '  (value) => {',
  '    const state = globalThis.__sandboxState;',
  '    try {',
  '      const json = JSON.stringify(value);',
  '      state.hasValue = json !== undefined;',
  '      state.payload = json === undefined ? "" : json;',
  '      state.status = "fulfilled";',
  '    } catch (e) {',
  '      state.payload = "Tool returned a non-serializable value: " + (e && e.message);',
  '      state.status = "failed";',
  '    }',
  '  },',
  '  (err) => {',
  '    const state = globalThis.__sandboxState;',
  '    state.payload = err && typeof err.message === "string" ? err.message : String(err);',
  '    state.status = "rejected";',
  '  }',
  ');',
].join('\n');

const asString = (value) => (typeof value === 'string' ? value : '');
const readState = (context, expression) => {
  try {
    return vm.runInContext(expression, context);
  } catch {
    return undefined;
  }
};
const readLogs = (context) => {
  const raw = readState(context, 'JSON.stringify(__sandboxState.logs)');
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l === 'string') : [];
  } catch {
    return [];
  }
};

const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});

let script;
try {
  script = new vm.Script(runner);
} catch (err) {
  parentPort.postMessage({
    success: false,
    thrown: false,
    error: 'Tool code does not compile: ' + (err && typeof err.message === 'string' ? err.message : String(err)),
    logs: [],
  });
}

let started = false;
if (script) try {
  vm.runInContext(BOOTSTRAP, context);
  script.runInContext(context, { timeout });
  started = true;
} catch (err) {
  const timedOut = err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
  parentPort.postMessage({
    success: false,
    thrown: !timedOut,
    error: timedOut
      ? 'Execution timeout: exceeded ' + timeout + 'ms'
      : err && typeof err.message === 'string' ? err.message : String(err),
    logs: readLogs(context),
  });
}

if (started) setImmediate(() => {
  const status = asString(readState(context, '__sandboxState.status'));
  const payload = asString(readState(context, '__sandboxState.payload'));
  const logs = readLogs(context);

  if (status === 'fulfilled') {
    let result;
    if (readState(context, '__sandboxState.hasValue') === true) {
      try {
        result = JSON.parse(payload);
      } catch {
        parentPort.postMessage({ success: false, thrown: false, error: 'Tool returned an unreadable value', logs });
        return;
      }
    }
    parentPort.postMessage({ success: true, result, logs });
  } else if (status === 'rejected') {
    parentPort.postMessage({ success: false, thrown: true, error: payload, logs });
  } else if (status === 'failed') {
    parentPort.postMessage({ success: false, thrown: false, error: payload, logs });
  } else {
    parentPort.postMessage({
      success: false,
      thrown: false,
      error: 'Tool execution never settled: execute() returned a promise that cannot resolve inside the sandbox',
      logs,
    });
  }
});
`;

interface WorkerMessage {
  success: boolean;
  result?: unknown;
  error?: string;
  thrown?: boolean;
  logs?: string[];
}

interface SandboxRun {
  result: ToolSandboxResult;
  thrownByTool: boolean;
}

export interface SandboxTestCase {
  input: unknown;
  expectedOutput?: unknown;
  shouldThrow?: boolean;
  allowThrow?: boolean;
}

export class ToolSandbox {
  private readonly config: ToolSandboxConfig;

  constructor(config: Partial<ToolSandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
  }

  async execute(tool: GeneratedTool, params: unknown): Promise<ToolSandboxResult> {
    const run = await this.run(tool, params);
    return run.result;
  }

  async testWithCases(
    tool: GeneratedTool,
    testCases: SandboxTestCase[]
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
      const { result: execResult, thrownByTool } = await this.run(tool, testCase.input);

      let passed: boolean;
      if (testCase.shouldThrow) {
        passed = !execResult.success && thrownByTool;
      } else if (testCase.expectedOutput !== undefined) {
        passed = execResult.success && deepEqual(execResult.result, testCase.expectedOutput);
      } else if (testCase.allowThrow) {
        passed = execResult.success || thrownByTool;
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

  private async run(tool: GeneratedTool, params: unknown): Promise<SandboxRun> {
    const startTime = Date.now();

    try {
      this.validateImplementation(tool.implementation);
    } catch (error) {
      return {
        result: failure(error instanceof Error ? error.message : String(error), startTime),
        thrownByTool: false,
      };
    }

    let paramsJson: string;
    try {
      paramsJson = JSON.stringify(params ?? null);
    } catch (error) {
      return {
        result: failure(
          `Parameters must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
          startTime
        ),
        thrownByTool: false,
      };
    }

    if (!this.config.enabled) {
      return this.executeUnsandboxed(tool, JSON.parse(paramsJson) as unknown, startTime);
    }

    return this.executeInWorker(tool.implementation, paramsJson, startTime);
  }

  private validateImplementation(code: string): void {
    const forbidden: Array<{ pattern: RegExp; label: string }> = [
      { pattern: /\beval\s*\(/, label: 'eval()' },
      { pattern: /\bnew\s+Function\s*\(/, label: 'new Function()' },
      { pattern: /\bFunction\s*\.\s*prototype/, label: 'Function.prototype' },
      { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
      { pattern: /\brequire\s*\(/, label: 'require()' },
      { pattern: /\bprocess\s*[[.]/, label: 'process access' },
      { pattern: /\bglobal\s*[[.]/, label: 'global access' },
      { pattern: /\bglobalThis\s*[[.]/, label: 'globalThis access' },
      { pattern: /\bwindow\s*[[.]/, label: 'window access' },
      { pattern: /\bdocument\s*[[.]/, label: 'document access' },
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
      { pattern: /\.\s*constructor\s*[[.(]/, label: 'constructor access' },
      { pattern: /\bgetPrototypeOf\s*\(/, label: 'getPrototypeOf()' },
      { pattern: /\bsetPrototypeOf\s*\(/, label: 'setPrototypeOf()' },
      { pattern: /\bReflect\s*[[.]/, label: 'Reflect access' },
      { pattern: /\bProxy\s*[[.(]/, label: 'Proxy access' },
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

  private executeInWorker(
    code: string,
    paramsJson: string,
    startTime: number
  ): Promise<SandboxRun> {
    return new Promise<SandboxRun>((resolve) => {
      let settled = false;
      let worker: Worker | undefined;

      const settle = (result: ToolSandboxResult, thrownByTool = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker) void worker.terminate();
        resolve({ result, thrownByTool });
      };

      let timer = setTimeout(() => {
        settle(
          failure(`Sandbox worker did not start within ${WORKER_STARTUP_TIMEOUT_MS}ms`, startTime)
        );
      }, WORKER_STARTUP_TIMEOUT_MS);

      const maxMemoryMb = Math.max(4, Math.ceil(this.config.maxMemory / (1024 * 1024)));

      try {
        worker = new Worker(WORKER_SOURCE, {
          eval: true,
          env: {},
          workerData: { code, paramsJson, timeout: this.config.maxExecutionTime },
          resourceLimits: {
            maxOldGenerationSizeMb: maxMemoryMb,
            maxYoungGenerationSizeMb: Math.max(2, Math.ceil(maxMemoryMb / 4)),
          },
        });
      } catch (error) {
        settle(
          failure(
            `Failed to create sandbox worker: ${error instanceof Error ? error.message : String(error)}`,
            startTime
          )
        );
        return;
      }

      worker.on('online', () => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          settle(
            failure(`Execution timeout: exceeded ${this.config.maxExecutionTime}ms`, startTime)
          );
        }, this.config.maxExecutionTime);
      });

      worker.on('message', (msg: WorkerMessage) => {
        const logs = msg.logs ?? [];
        if (msg.success) {
          settle({
            success: true,
            result: msg.result,
            executionTime: Date.now() - startTime,
            memoryUsed: estimateMemoryUsage(msg.result),
            logs,
          });
        } else {
          settle({ ...failure(msg.error ?? 'Tool execution failed', startTime), logs }, msg.thrown);
        }
      });

      worker.on('error', (error: Error & { code?: string }) => {
        settle(
          failure(
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? `Execution exceeded memory limit (${this.config.maxMemory} bytes)`
              : `Sandbox worker error: ${error.message}`,
            startTime
          )
        );
      });

      worker.on('exit', (exitCode: number) => {
        settle(
          failure(
            exitCode === 134 || exitCode === 137
              ? `Execution exceeded memory limit (${this.config.maxMemory} bytes)`
              : `Sandbox worker exited with code ${exitCode} before reporting a result`,
            startTime
          )
        );
      });
    });
  }

  private async executeUnsandboxed(
    tool: GeneratedTool,
    params: unknown,
    startTime: number
  ): Promise<SandboxRun> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const factory = new Function(`
        "use strict";
        ${tool.implementation}
        return execute;
      `) as () => unknown;
      const execute = factory();
      if (typeof execute !== 'function') {
        return {
          result: failure('Implementation must define an execute function', startTime),
          thrownByTool: false,
        };
      }

      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SandboxTimeoutError(this.config.maxExecutionTime)),
          this.config.maxExecutionTime
        );
      });
      const result: unknown = await Promise.race([
        (execute as (p: unknown) => unknown)(params),
        timeout,
      ]);

      return {
        result: {
          success: true,
          result,
          executionTime: Date.now() - startTime,
          memoryUsed: estimateMemoryUsage(result),
          logs: [],
        },
        thrownByTool: false,
      };
    } catch (error) {
      return {
        result: failure(error instanceof Error ? error.message : String(error), startTime),
        thrownByTool: !(error instanceof SandboxTimeoutError),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class SandboxTimeoutError extends Error {
  constructor(limit: number) {
    super(`Execution timeout: exceeded ${limit}ms`);
    this.name = 'SandboxTimeoutError';
  }
}

function failure(error: string, startTime: number): ToolSandboxResult {
  return {
    success: false,
    error,
    executionTime: Date.now() - startTime,
    memoryUsed: 0,
    logs: [],
  };
}

function estimateMemoryUsage(value: unknown): number {
  try {
    const str = JSON.stringify(value);
    return str ? str.length * 2 : 0;
  } catch {
    return 0;
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return deepEqualInner(a, b, new Map<object, Set<object>>());
}

function deepEqualInner(a: unknown, b: unknown, visited: Map<object, Set<object>>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const pairs = visited.get(a);
  if (pairs?.has(b)) return true;
  if (pairs) pairs.add(b);
  else visited.set(a, new Set([b]));

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  if (a instanceof RegExp || b instanceof RegExp) {
    return (
      a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags
    );
  }

  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || !deepEqualInner(val, b.get(key), visited)) return false;
    }
    return true;
  }

  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    const unmatched = [...b];
    for (const val of a) {
      const idx = unmatched.findIndex((candidate) => deepEqualInner(val, candidate, visited));
      if (idx === -1) return false;
      unmatched.splice(idx, 1);
    }
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    return a.every((val, i) => deepEqualInner(val, b[i], visited));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keysA = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
  const keysB = Object.keys(bObj).filter((k) => bObj[k] !== undefined);

  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(bObj, key) &&
      deepEqualInner(aObj[key], bObj[key], visited)
  );
}
