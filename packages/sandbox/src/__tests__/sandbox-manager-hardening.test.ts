import { describe, it, expect, vi, afterEach } from 'vitest';
import { SandboxManager } from '../sandbox-manager';
import { DockerSandboxExecutor } from '../executors/docker';
import { WasmSandboxExecutor } from '../executors/wasm';

describe('SandboxManager hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes executors only once under concurrent calls', async () => {
    const dockerConnect = vi
      .spyOn(DockerSandboxExecutor.prototype, 'connect')
      .mockResolvedValue({ success: false, error: 'no docker' });
    const wasmConnect = vi
      .spyOn(WasmSandboxExecutor.prototype, 'connect')
      .mockResolvedValue({ success: false, error: 'no wasm' });
    const manager = new SandboxManager();

    await Promise.all([
      manager.initialize(),
      manager.execute({ command: ['echo', 'a'] }, { type: 'native' }),
      manager.isDockerAvailable(),
    ]);

    expect(dockerConnect).toHaveBeenCalledTimes(1);
    expect(wasmConnect).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('applies manager defaults when falling back to another executor', async () => {
    vi.spyOn(DockerSandboxExecutor.prototype, 'connect').mockResolvedValue({
      success: false,
      error: 'no docker',
    });
    vi.spyOn(WasmSandboxExecutor.prototype, 'connect').mockResolvedValue({
      success: false,
      error: 'no wasm',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new SandboxManager({ defaults: { env: { FROM_DEFAULTS: 'yes' } } });

    const result = await manager.execute(
      { command: ['echo $FROM_DEFAULTS'] },
      { type: 'docker', image: 'alpine:3.19' }
    );

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.stdout.trim()).toBe('yes');
    await manager.shutdown();
  });

  it('refuses to run a Docker command on the host with allowNativeFallback: false', async () => {
    vi.spyOn(DockerSandboxExecutor.prototype, 'connect').mockResolvedValue({
      success: false,
      error: 'no docker',
    });
    const manager = new SandboxManager({ allowNativeFallback: false });

    const result = await manager.execute(
      { command: ['touch', '/tmp/should-not-exist'] },
      { type: 'docker', image: 'alpine:3.19' }
    );

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('allowNativeFallback is false'),
    });
    await manager.shutdown();
  });

  it('warns once when it runs Docker commands on the host', async () => {
    vi.spyOn(DockerSandboxExecutor.prototype, 'connect').mockResolvedValue({
      success: false,
      error: 'no docker',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new SandboxManager();

    await manager.execute({ command: ['echo', 'a'] }, { type: 'docker' });
    await manager.execute({ command: ['echo', 'b'] }, { type: 'docker' });

    const fallbackWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('UNSANDBOXED')
    );
    expect(fallbackWarnings).toHaveLength(1);
    await manager.shutdown();
  });

  it('never runs a WASM tool in another sandbox', async () => {
    vi.spyOn(WasmSandboxExecutor.prototype, 'connect').mockResolvedValue({
      success: false,
      error: 'no extism',
    });
    const dockerExecute = vi.spyOn(DockerSandboxExecutor.prototype, 'execute');
    const manager = new SandboxManager();

    const result = await manager.execute(
      { command: [], stdin: '{}' },
      { type: 'wasm', wasmModule: 'tool.wasm' }
    );

    expect(result).toEqual({
      success: false,
      error: 'WASM sandbox unavailable: install @extism/extism to run WASM tools',
    });
    expect(dockerExecute).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it('can be re-initialized after shutdown', async () => {
    const manager = new SandboxManager();
    await manager.initialize();
    await manager.shutdown();

    const result = await manager.execute({ command: ['echo', 'again'] }, { type: 'native' });

    expect(result.success).toBe(true);
    await manager.shutdown();
  });
});
