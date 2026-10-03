import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxExecutionResult, SandboxResult } from '@cogitator-ai/types';
import { WasmSandboxExecutor } from '../executors/wasm';
import { buildExtismTestModule } from './fixtures/extism-test-module';

function assertSuccess(
  result: SandboxResult<SandboxExecutionResult>
): asserts result is { success: true; data: SandboxExecutionResult } {
  if (!result.success) throw new Error(`Expected success, got: ${result.error}`);
}

describe('WasmSandboxExecutor with a real Extism runtime', () => {
  let dir: string;
  let modulePath: string;
  let executor: WasmSandboxExecutor;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cogitator-wasm-'));
    modulePath = join(dir, 'test.wasm');
    await writeFile(modulePath, buildExtismTestModule());
    executor = new WasmSandboxExecutor();
    const connected = await executor.connect();
    expect(connected.success).toBe(true);
  });

  afterAll(async () => {
    await executor.disconnect();
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a local module file and returns its output', async () => {
    const result = await executor.execute(
      { command: [], stdin: 'hello wasm' },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'echo' }
    );

    assertSuccess(result);
    expect(result.data.stdout).toBe('hello wasm');
    expect(result.data.exitCode).toBe(0);
  });

  it('parses JSON results into stdout, stderr and exit code', async () => {
    const result = await executor.execute(
      { command: [], stdin: JSON.stringify({ stdout: 'out', stderr: 'err', exitCode: 3 }) },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'echo' }
    );

    assertSuccess(result);
    expect(result.data).toMatchObject({ stdout: 'out', stderr: 'err', exitCode: 3 });
  });

  it('runs concurrent executions without reentrancy errors', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((input) =>
        executor.execute(
          { command: [], stdin: input },
          { type: 'wasm', wasmModule: modulePath, wasmFunction: 'echo' }
        )
      )
    );

    expect(results.map((r) => (r.success ? r.data.stdout : r.error))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('terminates runaway modules on timeout and keeps working afterwards', async () => {
    const started = Date.now();
    const spin = await executor.execute(
      { command: [], stdin: 'x', timeout: 300 },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'spin' }
    );

    assertSuccess(spin);
    expect(spin.data.timedOut).toBe(true);
    expect(spin.data.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(3000);

    const after = await executor.execute(
      { command: [], stdin: 'still alive' },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'echo' }
    );
    assertSuccess(after);
    expect(after.data.stdout).toBe('still alive');
  });

  it("caps the module's own memory at memoryPages", async () => {
    const limited = new WasmSandboxExecutor({ wasm: { memoryPages: 4 } });
    await limited.connect();
    try {
      const result = await limited.execute(
        { command: [], stdin: '' },
        { type: 'wasm', wasmModule: modulePath, wasmFunction: 'grow' }
      );

      assertSuccess(result);
      expect(result.data.exitCode).toBe(1);
    } finally {
      await limited.disconnect();
    }
  });

  it('lets the module grow its memory within memoryPages', async () => {
    const roomy = new WasmSandboxExecutor({ wasm: { memoryPages: 2048 } });
    await roomy.connect();
    try {
      const result = await roomy.execute(
        { command: [], stdin: '' },
        { type: 'wasm', wasmModule: modulePath, wasmFunction: 'grow' }
      );

      assertSuccess(result);
      expect(result.data.exitCode).toBe(0);
    } finally {
      await roomy.disconnect();
    }
  });

  it('reports missing functions as a failed execution', async () => {
    const result = await executor.execute(
      { command: [], stdin: 'x' },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'does_not_exist' }
    );

    assertSuccess(result);
    expect(result.data.exitCode).toBe(1);
    expect(result.data.stderr).toContain('does_not_exist');
  });

  it('falls back to module and function defaults from the executor options', async () => {
    const withDefaults = new WasmSandboxExecutor({
      wasm: { wasmModule: modulePath, functionName: 'echo' },
    });
    await withDefaults.connect();

    const result = await withDefaults.execute({ command: [], stdin: 'defaults' }, { type: 'wasm' });

    assertSuccess(result);
    expect(result.data.stdout).toBe('defaults');
    await withDefaults.disconnect();
  });
});
