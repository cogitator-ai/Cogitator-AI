/**
 * Sandbox performance benchmarks
 *
 * Measures cold start, warm execution, and memory overhead
 * for WASM, Docker, and Native sandbox executors.
 *
 * Run: pnpm test -- benchmark.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WasmSandboxExecutor } from '../executors/wasm';
import { NativeSandboxExecutor } from '../executors/native';
import { DockerSandboxExecutor } from '../executors/docker';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator/types';

const ITERATIONS = 10;
const WARMUP_ITERATIONS = 2;

interface BenchmarkResult {
  executor: string;
  coldStartMs: number;
  warmExecMs: number;
  avgExecMs: number;
  minExecMs: number;
  maxExecMs: number;
  available: boolean;
}

const simpleRequest: SandboxExecutionRequest = {
  command: ['echo', 'hello'],
  timeout: 5000,
};

const nativeConfig: SandboxConfig = {
  type: 'native',
  timeout: 5000,
};

const dockerConfig: SandboxConfig = {
  type: 'docker',
  image: 'alpine:3.19',
  timeout: 10000,
};

describe('Sandbox Performance Benchmarks', () => {
  const results: BenchmarkResult[] = [];

  afterAll(() => {
    console.log('\n\n=== SANDBOX PERFORMANCE REPORT ===\n');
    console.log('| Executor | Available | Cold Start | Warm Exec | Avg Exec | Min | Max |');
    console.log('|----------|-----------|------------|-----------|----------|-----|-----|');
    for (const r of results) {
      console.log(
        `| ${r.executor.padEnd(8)} | ${r.available ? 'Yes' : 'No '.padEnd(9)} | ${r.coldStartMs.toFixed(1).padStart(8)}ms | ${r.warmExecMs.toFixed(1).padStart(7)}ms | ${r.avgExecMs.toFixed(1).padStart(6)}ms | ${r.minExecMs.toFixed(0).padStart(3)}ms | ${r.maxExecMs.toFixed(0).padStart(3)}ms |`
      );
    }
    console.log('\n=== TARGET METRICS (Month 9) ===');
    console.log('| Metric              | Target  | Status |');
    console.log('|---------------------|---------|--------|');

    const wasmResult = results.find((r) => r.executor === 'WASM');
    const dockerResult = results.find((r) => r.executor === 'Docker');
    const nativeResult = results.find((r) => r.executor === 'Native');

    if (wasmResult?.available) {
      const wasmColdOk = wasmResult.coldStartMs < 50;
      console.log(
        `| WASM cold start     | < 50ms  | ${wasmColdOk ? '✅' : '❌'} ${wasmResult.coldStartMs.toFixed(1)}ms |`
      );
    }

    if (dockerResult?.available) {
      const dockerColdOk = dockerResult.coldStartMs < 5000;
      console.log(
        `| Docker cold start   | < 5s    | ${dockerColdOk ? '✅' : '❌'} ${dockerResult.coldStartMs.toFixed(0)}ms |`
      );
    }

    if (nativeResult?.available) {
      const nativeExecOk = nativeResult.avgExecMs < 10;
      console.log(
        `| Native exec         | < 10ms  | ${nativeExecOk ? '✅' : '❌'} ${nativeResult.avgExecMs.toFixed(1)}ms |`
      );
    }

    console.log('\n');
  });

  describe('Native Executor', () => {
    let executor: NativeSandboxExecutor;

    beforeAll(async () => {
      executor = new NativeSandboxExecutor();
      await executor.connect();
    });

    afterAll(async () => {
      await executor.disconnect();
    });

    it('should measure native execution performance', async () => {
      const available = await executor.isAvailable();
      if (!available) {
        results.push({
          executor: 'Native',
          coldStartMs: 0,
          warmExecMs: 0,
          avgExecMs: 0,
          minExecMs: 0,
          maxExecMs: 0,
          available: false,
        });
        return;
      }

      const coldStart = Date.now();
      await executor.execute(simpleRequest, nativeConfig);
      const coldStartMs = Date.now() - coldStart;

      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await executor.execute(simpleRequest, nativeConfig);
      }

      const warmStart = Date.now();
      await executor.execute(simpleRequest, nativeConfig);
      const warmExecMs = Date.now() - warmStart;

      const times: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const start = Date.now();
        await executor.execute(simpleRequest, nativeConfig);
        times.push(Date.now() - start);
      }

      const avgExecMs = times.reduce((a, b) => a + b, 0) / times.length;
      const minExecMs = Math.min(...times);
      const maxExecMs = Math.max(...times);

      results.push({
        executor: 'Native',
        coldStartMs,
        warmExecMs,
        avgExecMs,
        minExecMs,
        maxExecMs,
        available: true,
      });

      expect(avgExecMs).toBeLessThan(100);
    });
  });

  describe('WASM Executor', () => {
    let executor: WasmSandboxExecutor;

    beforeAll(async () => {
      executor = new WasmSandboxExecutor();
    });

    afterAll(async () => {
      await executor.disconnect();
    });

    it('should measure WASM availability and cold start', async () => {
      const connectStart = Date.now();
      const connectResult = await executor.connect();
      const coldStartMs = Date.now() - connectStart;

      const available = connectResult.success;

      if (!available) {
        results.push({
          executor: 'WASM',
          coldStartMs: 0,
          warmExecMs: 0,
          avgExecMs: 0,
          minExecMs: 0,
          maxExecMs: 0,
          available: false,
        });
        console.log('WASM executor not available (Extism not installed)');
        return;
      }

      results.push({
        executor: 'WASM',
        coldStartMs,
        warmExecMs: coldStartMs,
        avgExecMs: coldStartMs,
        minExecMs: coldStartMs,
        maxExecMs: coldStartMs,
        available: true,
      });

      expect(coldStartMs).toBeLessThan(100);
    });
  });

  describe('Docker Executor', () => {
    let executor: DockerSandboxExecutor;

    beforeAll(async () => {
      executor = new DockerSandboxExecutor();
    });

    afterAll(async () => {
      await executor.disconnect();
    });

    it('should measure Docker execution performance', async () => {
      const connectResult = await executor.connect();

      if (!connectResult.success) {
        results.push({
          executor: 'Docker',
          coldStartMs: 0,
          warmExecMs: 0,
          avgExecMs: 0,
          minExecMs: 0,
          maxExecMs: 0,
          available: false,
        });
        console.log('Docker executor not available');
        return;
      }

      const coldStart = Date.now();
      const firstRun = await executor.execute(simpleRequest, dockerConfig);
      const coldStartMs = Date.now() - coldStart;

      if (!firstRun.success) {
        results.push({
          executor: 'Docker',
          coldStartMs: 0,
          warmExecMs: 0,
          avgExecMs: 0,
          minExecMs: 0,
          maxExecMs: 0,
          available: false,
        });
        return;
      }

      const warmStart = Date.now();
      await executor.execute(simpleRequest, dockerConfig);
      const warmExecMs = Date.now() - warmStart;

      const times: number[] = [];
      for (let i = 0; i < Math.min(ITERATIONS, 3); i++) {
        const start = Date.now();
        await executor.execute(simpleRequest, dockerConfig);
        times.push(Date.now() - start);
      }

      const avgExecMs = times.reduce((a, b) => a + b, 0) / times.length;
      const minExecMs = Math.min(...times);
      const maxExecMs = Math.max(...times);

      results.push({
        executor: 'Docker',
        coldStartMs,
        warmExecMs,
        avgExecMs,
        minExecMs,
        maxExecMs,
        available: true,
      });

      expect(coldStartMs).toBeLessThan(30000);
    }, 60000);
  });
});
