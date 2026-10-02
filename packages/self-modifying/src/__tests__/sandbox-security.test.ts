import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GeneratedTool } from '@cogitator-ai/types';
import { ToolSandbox, deepEqual } from '../tool-generation';

function makeTool(implementation: string): GeneratedTool {
  return {
    id: 'sandbox_test',
    name: 'sandbox_test',
    description: 'sandbox test tool',
    implementation,
    parameters: { type: 'object', properties: {} },
    createdAt: new Date(),
    version: 1,
    status: 'validated',
  };
}

describe('ToolSandbox isolation', () => {
  const sandbox = new ToolSandbox({ enabled: true, maxExecutionTime: 3000 });

  it('blocks constructor-chain escapes to the host realm', async () => {
    const result = await sandbox.execute(
      makeTool(`async function execute() {
        const F = Array["constr" + "uctor"];
        return F("return pro" + "cess")();
      }`),
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/code generation/i);
  });

  it('does not expose host globals inside the sandbox', async () => {
    const result = await sandbox.execute(
      makeTool(`async function execute() {
        return [typeof process, typeof require, typeof setTimeout, typeof Buffer];
      }`),
      {}
    );

    expect(result.success).toBe(true);
    expect(result.result).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('passes params as sandbox-realm data that cannot reach host constructors', async () => {
    const result = await sandbox.execute(
      makeTool(`async function execute(params) {
        const ctor = params["constr" + "uctor"]["constr" + "uctor"];
        return ctor("return 1")();
      }`),
      { a: 1 }
    );

    expect(result.success).toBe(false);
  });

  it('captures console output with JSON-formatted objects', async () => {
    const result = await sandbox.execute(
      makeTool(`async function execute(params) {
        console.log("value", { a: params.a });
        console.warn("careful");
        return params.a;
      }`),
      { a: 5 }
    );

    expect(result.success).toBe(true);
    expect(result.logs).toEqual(['[LOG] value {"a":5}', '[WARN] careful']);
  });

  it('reports promises that can never settle without waiting for the timeout', async () => {
    const started = Date.now();
    const result = await sandbox.execute(
      makeTool('async function execute() { return new Promise(() => {}); }'),
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/never settled/);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('rejects non-serializable parameters', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = await sandbox.execute(
      makeTool('async function execute(p) { return 1; }'),
      circular
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/JSON-serializable/);
  });

  it('reports non-serializable results instead of crashing the worker', async () => {
    const result = await sandbox.execute(
      makeTool('async function execute() { const a = {}; a.self = a; return a; }'),
      {}
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-serializable/);
  });

  it('allows RegExp.prototype.exec in generated code', async () => {
    const result = await sandbox.execute(
      makeTool('async function execute(p) { return /(\\d+)/.exec(p.text)[1]; }'),
      { text: 'order 42' }
    );

    expect(result).toMatchObject({ success: true, result: '42' });
  });
});

describe('ToolSandbox.testWithCases', () => {
  const sandbox = new ToolSandbox({ enabled: true, maxExecutionTime: 500 });

  it('distinguishes thrown errors from timeouts for shouldThrow and allowThrow cases', async () => {
    const tool = makeTool(`async function execute(params) {
      if (params.mode === 'throw') throw new Error('invalid input');
      if (params.mode === 'hang') { while (true) {} }
      return 'ok';
    }`);

    const { results } = await sandbox.testWithCases(tool, [
      { input: { mode: 'throw' }, shouldThrow: true },
      { input: { mode: 'throw' }, allowThrow: true },
      { input: { mode: 'ok' }, allowThrow: true },
      { input: { mode: 'hang' }, shouldThrow: true },
      { input: { mode: 'hang' }, allowThrow: true },
    ]);

    expect(results.map((r) => r.passed)).toEqual([true, true, true, false, false]);
  });
});

describe('ToolSandbox without isolation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears its timeout timer after execution completes', async () => {
    vi.useFakeTimers();
    const sandbox = new ToolSandbox({ enabled: false, maxExecutionTime: 60_000 });

    const result = await sandbox.execute(
      makeTool('async function execute(p) { return p.a * 2; }'),
      { a: 21 }
    );

    expect(result).toMatchObject({ success: true, result: 42 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('deepEqual', () => {
  it('treats shared references and distinct copies as equal', () => {
    const shared = { v: 1 };
    expect(deepEqual({ a: shared, b: shared }, { a: { v: 1 }, b: { v: 1 } })).toBe(true);
  });

  it('handles circular arrays and objects without overflowing the stack', () => {
    const a: unknown[] = [1];
    a.push(a);
    const b: unknown[] = [1];
    b.push(b);
    expect(deepEqual(a, b)).toBe(true);

    const x: Record<string, unknown> = { n: 1 };
    x.self = x;
    const y: Record<string, unknown> = { n: 2 };
    y.self = y;
    expect(deepEqual(x, y)).toBe(false);
  });

  it('compares sets of objects structurally', () => {
    expect(deepEqual(new Set([{ a: 1 }]), new Set([{ a: 1 }]))).toBe(true);
    expect(deepEqual(new Set([{ a: 1 }]), new Set([{ a: 2 }]))).toBe(false);
  });

  it('distinguishes arrays from plain objects', () => {
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});
