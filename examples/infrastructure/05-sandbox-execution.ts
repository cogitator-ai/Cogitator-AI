import { header, section } from '../_shared/setup.js';
import {
  SandboxManager,
  NativeSandboxExecutor,
  parseMemory,
  cpusToNanoCpus,
} from '@cogitator-ai/sandbox';

async function main() {
  header('05 — Sandbox Execution: Docker, WASM & Native');

  section('1. Native executor (always available)');

  const native = new NativeSandboxExecutor();
  await native.connect();

  const nativeResult = await native.execute(
    { command: ['echo', 'Hello from native sandbox!'] },
    { type: 'native', timeout: 5000 }
  );

  if (nativeResult.success) {
    console.log('  stdout:', nativeResult.data.stdout.trim());
    console.log('  exitCode:', nativeResult.data.exitCode);
    console.log('  duration:', nativeResult.data.duration, 'ms');
  }

  section('2. SandboxManager with fallback');

  const manager = new SandboxManager({
    defaults: {
      timeout: 10_000,
      resources: { memory: '256MB', cpus: 0.5 },
      network: { mode: 'none' },
    },
    pool: { maxSize: 3, idleTimeoutMs: 30_000 },
  });

  await manager.initialize();

  const dockerAvailable = await manager.isDockerAvailable();
  const wasmAvailable = await manager.isWasmAvailable();
  console.log('  Docker available:', dockerAvailable);
  console.log('  WASM available:', wasmAvailable);

  const result = await manager.execute(
    {
      command: ['node', '-e', 'console.log(JSON.stringify({ sum: 2 + 2 }))'],
      env: { NODE_ENV: 'sandbox' },
    },
    {
      type: dockerAvailable ? 'docker' : 'native',
      image: 'node:20-alpine',
    }
  );

  if (result.success) {
    console.log('  output:', result.data.stdout.trim());
    console.log('  exit:', result.data.exitCode);
  } else {
    console.log('  error:', result.error);
  }

  section('3. Utility functions');

  console.log('  parseMemory("256MB"):', parseMemory('256MB'), 'bytes');
  console.log('  parseMemory("1GB"):', parseMemory('1GB'), 'bytes');
  console.log('  cpusToNanoCpus(0.5):', cpusToNanoCpus(0.5), 'nanocpus');

  section('4. Timeout handling');

  const timeoutResult = await manager.execute(
    { command: ['sleep', '30'], timeout: 500 },
    { type: 'native' }
  );

  if (timeoutResult.success) {
    console.log('  timedOut:', timeoutResult.data.timedOut);
    console.log('  exitCode:', timeoutResult.data.exitCode);
  }

  await manager.shutdown();
  console.log('\n  Sandbox manager shut down.');
}

main().catch(console.error);
