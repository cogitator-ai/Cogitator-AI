import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Agent, tool } from '@cogitator-ai/core';
import {
  SandboxManager,
  type SandboxConfig,
  type SandboxExecutionResult,
} from '@cogitator-ai/sandbox';
import { getWasmPath } from '@cogitator-ai/wasm-tools';
import { z } from 'zod';
import { PACKAGE_DIR } from '../../packages.js';
import type { StageDefinition } from '../../runner/types.js';
import { CORE, SANDBOX, TYPES, WASM_TOOLS, assertCalled, calledTools, excerpt } from './shared.js';

const IMAGE = 'alpine:3.19';
const execFileAsync = promisify(execFile);

/**
 * Hand-assembled WASM modules, so the executor's guarantees are tested without a toolchain.
 * `LOOP` exports `run`, which never returns. `HUNGRY` asks for 300 memory pages at start,
 * more than the executor's default cap of 256.
 */
const LOOP = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
  0x02, 0x01, 0x00, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x10, 0x02, 0x03, 0x72, 0x75, 0x6e, 0x00,
  0x00, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x0a, 0x0b, 0x01, 0x09, 0x00, 0x03,
  0x40, 0x0c, 0x00, 0x0b, 0x41, 0x00, 0x0b,
]);
const HUNGRY = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03,
  0x02, 0x01, 0x00, 0x05, 0x04, 0x01, 0x00, 0xac, 0x02, 0x07, 0x10, 0x02, 0x03, 0x72, 0x75, 0x6e,
  0x00, 0x00, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00,
  0x41, 0x00, 0x0b,
]);

/** Unwraps a sandbox result, failing the check on an executor error. */
function data(result: Awaited<ReturnType<SandboxManager['execute']>>): SandboxExecutionResult {
  if (!result.success) throw new Error(`Sandbox error: ${result.error}`);
  return result.data;
}

/** Parses the JSON a WASM tool module writes to its output. */
function stdoutJson(result: SandboxExecutionResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/**
 * The WASM executor runs a pre-built module, kills a runaway one, refuses an oversized one, and
 * the manager refuses to run a Docker request on the host when told to. No Docker needed.
 */
export const sandboxWasmStage: StageDefinition = {
  id: 'sandbox-wasm',
  title: 'WASM sandbox and fallback policy',
  description:
    'The WASM executor runs a pre-built module, terminates a runaway one, enforces its memory cap, and Docker requests are refused instead of running on the host.',
  packages: [SANDBOX, WASM_TOOLS, TYPES],
  timeoutMs: 60_000,
  async run(ctx) {
    const manager = new SandboxManager({ allowNativeFallback: false });
    ctx.onCleanup(() => manager.shutdown());
    const calc: SandboxConfig = {
      type: 'wasm',
      wasmModule: getWasmPath('calc'),
      wasmFunction: 'calculate',
      wasi: true,
      timeout: 5_000,
    };

    await ctx.check('WASM executor is available', async (evidence) => {
      const available = await manager.isWasmAvailable();
      evidence('wasm', available);
      if (!available)
        throw new Error('isWasmAvailable() is false although @extism/extism is installed');
    });

    await ctx.check('pre-built module runs with JSON on stdin', async (evidence) => {
      const result = data(
        await manager.execute({ command: [], stdin: JSON.stringify({ expression: '6 * 7' }) }, calc)
      );
      evidence('stdout', result.stdout);
      evidence('durationMs', result.duration);
      if (result.exitCode !== 0 || stdoutJson(result).result !== 42)
        throw new Error('Wrong module output');
    });

    const modules = join(ctx.tmpDir, 'wasm');
    await mkdir(modules, { recursive: true });
    await writeFile(join(modules, 'loop.wasm'), LOOP);
    await writeFile(join(modules, 'hungry.wasm'), HUNGRY);

    await ctx.check('runaway module is terminated at the timeout', async (evidence) => {
      const started = Date.now();
      const result = data(
        await manager.execute(
          { command: [], timeout: 1_500 },
          { type: 'wasm', wasmModule: join(modules, 'loop.wasm'), wasmFunction: 'run' }
        )
      );
      evidence('timedOut', result.timedOut);
      evidence('exitCode', result.exitCode);
      evidence('elapsedMs', Date.now() - started);
      if (!result.timedOut || result.exitCode !== 124)
        throw new Error('The loop was not reported as timed out');
      if (Date.now() - started > 6_000) throw new Error('The timeout fired far too late');
      const after = data(
        await manager.execute({ command: [], stdin: JSON.stringify({ expression: '1 + 1' }) }, calc)
      );
      evidence('afterTimeout', after.stdout);
      if (stdoutJson(after).result !== 2) throw new Error('The executor broke after a timeout');
    });

    await ctx.check('module above the memory cap is refused', async (evidence) => {
      const result = await manager.execute(
        { command: [] },
        { type: 'wasm', wasmModule: join(modules, 'hungry.wasm'), wasmFunction: 'run' }
      );
      evidence('result', result);
      if (result.success) throw new Error('A module needing 300 pages ran under a 256-page cap');
      if (!/memory/i.test(result.error ?? ''))
        throw new Error('The refusal does not mention memory');
    });

    await ctx.check('Docker request is refused when native fallback is off', async (evidence) => {
      const noDocker = new SandboxManager({
        allowNativeFallback: false,
        docker: { socketPath: join(ctx.tmpDir, 'no-docker.sock') },
      });
      ctx.onCleanup(() => noDocker.shutdown());
      const marker = join(ctx.tmpDir, 'host-marker');
      const result = await noDocker.execute(
        { command: ['sh', '-c', `echo ran > ${marker}`] },
        { type: 'docker', image: IMAGE }
      );
      evidence('result', result);
      if (result.success) throw new Error('The command ran although Docker is unavailable');
      const ranOnHost = await access(marker).then(
        () => true,
        () => false
      );
      evidence('ranOnHost', ranOnHost);
      if (ranOnHost) throw new Error('The command ran on the host');
    });

    await ctx.check('module specifier resolves in a plain Node app', async (evidence) => {
      const specifier = '@cogitator-ai/wasm-tools/wasm/calc.wasm';
      const script = [
        "import { SandboxManager } from '@cogitator-ai/sandbox';",
        'const manager = new SandboxManager({ allowNativeFallback: false });',
        'const result = await manager.execute(',
        "  { command: [], stdin: JSON.stringify({ expression: '3 * 3' }) },",
        `  { type: 'wasm', wasmModule: '${specifier}', wasmFunction: 'calculate', wasi: true }`,
        ');',
        'await manager.shutdown();',
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n');
      const { NODE_PATH: launcherPath, ...env } = process.env;
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--input-type=module', '-e', script],
        {
          cwd: PACKAGE_DIR,
          env,
          timeout: 30_000,
          signal: ctx.signal,
        }
      );
      evidence('strippedNodePath', Boolean(launcherPath));
      const result = JSON.parse(stdout) as Awaited<ReturnType<SandboxManager['execute']>>;
      evidence('specifier', specifier);
      evidence('runtime', `node ${process.version}, no loader`);
      evidence('result', result.success ? result.data.stdout : result.error);
      if (!result.success) throw new Error(result.error);
      if (stdoutJson(result.data).result !== 9) throw new Error('Wrong module output');
    });
  },
};

/**
 * Code runs in throwaway Alpine containers: output, stdin, exit codes, no network, dropped
 * capabilities, resource limits, no host filesystem, no state between runs, timeouts, and a
 * Docker-sandboxed tool called by an agent.
 */
export const sandboxDockerStage: StageDefinition = {
  id: 'sandbox-docker',
  title: 'Docker sandbox',
  description:
    'Commands run in hardened throwaway containers with no network, no capabilities, enforced limits and timeouts, and an agent runs a shell tool inside one.',
  packages: [SANDBOX, CORE, TYPES],
  needs: ['handshake'],
  requires: [{ kind: 'docker' }],
  timeoutMs: 180_000,
  async run(ctx) {
    const manager = new SandboxManager({ allowNativeFallback: false, pool: { maxSize: 2 } });
    ctx.onCleanup(() => manager.shutdown());
    const alpine: SandboxConfig = {
      type: 'docker',
      image: IMAGE,
      timeout: 60_000,
      resources: { memory: '64MB', pidsLimit: 32 },
    };
    const sh = async (
      script: string,
      extra: { stdin?: string; timeout?: number } = {},
      config = alpine
    ) => data(await manager.execute({ command: ['sh', '-c', script], ...extra }, config));

    await ctx.check('Docker executor connects', async (evidence) => {
      const available = await manager.isDockerAvailable();
      evidence('docker', available);
      if (!available) throw new Error('isDockerAvailable() is false although the daemon answers');
    });

    await ctx.check('command output, stdin and exit code come back', async (evidence) => {
      const computed = await sh('echo $((6 * 7)); cat /etc/alpine-release');
      evidence('stdout', computed.stdout.trim().split('\n'));
      if (!computed.stdout.startsWith('42\n3.19')) throw new Error('Unexpected container output');
      const piped = await sh('tr a-z A-Z', { stdin: 'gauntlet' });
      evidence('stdin', piped.stdout);
      if (piped.stdout.trim() !== 'GAUNTLET') throw new Error('stdin did not reach the command');
      const failed = await sh('echo boom >&2; exit 42');
      evidence('exitCode', failed.exitCode);
      evidence('stderr', failed.stderr.trim());
      if (failed.exitCode !== 42 || failed.stderr.trim() !== 'boom')
        throw new Error('Exit code or stderr lost');
    });

    await ctx.check('container has no network and no capabilities', async (evidence) => {
      const result = await sh(
        'ls /sys/class/net | tr "\\n" " "; echo; wget -T 3 -q -O- http://1.1.1.1 >/dev/null 2>&1; echo "wget=$?"; grep CapEff /proc/self/status'
      );
      const [interfaces = '', wget = '', caps = ''] = result.stdout.trim().split('\n');
      evidence('interfaces', interfaces.trim());
      evidence('wget', wget);
      evidence('capEff', caps.replace(/\s+/g, ' '));
      if (interfaces.trim() !== 'lo') throw new Error(`Network interfaces present: ${interfaces}`);
      if (wget === 'wget=0') throw new Error('An outbound request succeeded');
      if (!/CapEff:\s*0+$/.test(caps)) throw new Error('Capabilities were not dropped');
    });

    await ctx.check('memory and process limits are applied', async (evidence) => {
      const result = await sh('cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max');
      const [memory, pids] = result.stdout.trim().split('\n');
      evidence('memoryMax', memory);
      evidence('pidsMax', pids);
      if (memory !== String(64 * 1024 * 1024)) throw new Error(`memory.max is ${memory}`);
      if (pids !== '32') throw new Error(`pids.max is ${pids}`);
    });

    await ctx.check('host filesystem is invisible and runs share nothing', async (evidence) => {
      const hostFile = join(ctx.tmpDir, 'host-secret.txt');
      await writeFile(hostFile, 'host only');
      const probe = await sh(`test -e "${hostFile}" && echo visible || echo hidden`);
      evidence('hostPath', probe.stdout.trim());
      if (probe.stdout.trim() !== 'hidden')
        throw new Error('A host path is visible inside the container');
      await sh('echo first-run > /workspace/leftover');
      const second = await sh('test -e /workspace/leftover && echo leaked || echo clean');
      evidence('secondRun', second.stdout.trim());
      if (second.stdout.trim() !== 'clean') throw new Error('A file from the previous run leaked');
    });

    await ctx.check('read-only mount is readable but not writable', async (evidence) => {
      const shared = join(ctx.tmpDir, 'shared');
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, 'input.txt'), 'mounted payload');
      const result = await sh(
        'cat /data/input.txt; echo; echo tamper > /data/input.txt 2>/dev/null && echo writable || echo read-only',
        {},
        { ...alpine, mounts: [{ source: shared, target: '/data', readOnly: true }] }
      );
      const [content, mode] = result.stdout.trim().split('\n');
      evidence('content', content);
      evidence('mode', mode);
      if (content !== 'mounted payload') throw new Error('The mounted file was not readable');
      if (mode !== 'read-only') throw new Error('A read-only mount accepted a write');
    });

    await ctx.check('timeout kills a long command', async (evidence) => {
      const started = Date.now();
      const result = data(
        await manager.execute({ command: ['sleep', '30'], timeout: 2_000 }, alpine)
      );
      evidence('timedOut', result.timedOut);
      evidence('exitCode', result.exitCode);
      evidence('elapsedMs', Date.now() - started);
      if (!result.timedOut) throw new Error('sleep 30 was not reported as timed out');
      if (Date.now() - started > 15_000) throw new Error('The timeout fired far too late');
    });

    await ctx.check('agent runs a Docker-sandboxed tool', async (evidence) => {
      let hostExecutions = 0;
      const shell = tool({
        name: 'run_shell',
        description:
          'Run a shell command in an isolated Alpine Linux container and return its output.',
        parameters: z.object({ command: z.string().describe('POSIX shell command') }),
        sandbox: {
          type: 'docker',
          image: IMAGE,
          network: { mode: 'none' },
          resources: { memory: '64MB' },
        },
        timeout: 30_000,
        execute: async ({ command }) => {
          hostExecutions++;
          return command;
        },
      });
      const cogitator = ctx.createCogitator({
        sandbox: { allowNativeFallback: false, pool: { maxSize: 1 } },
      });
      const agent = new Agent({
        name: 'container-operator',
        model: ctx.model,
        instructions:
          'You inspect the machine only through run_shell. Never guess: run the command and report exactly what it printed.',
        tools: [shell],
        maxIterations: 4,
      });
      const run = await cogitator.run(agent, {
        input: 'Which Alpine Linux release is installed? Read it from /etc/alpine-release.',
        signal: ctx.signal,
      });
      evidence('toolCalls', calledTools(run));
      evidence('hostExecutions', hostExecutions);
      evidence('output', excerpt(run.output));
      assertCalled(run, 'run_shell');
      if (hostExecutions > 0) throw new Error('The tool ran on the host instead of in Docker');
      if (!run.output.includes('3.19'))
        throw new Error('The answer lacks the release read in the container');
    });
  },
};
