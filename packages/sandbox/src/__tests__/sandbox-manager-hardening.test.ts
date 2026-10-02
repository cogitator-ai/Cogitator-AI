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

  it('can be re-initialized after shutdown', async () => {
    const manager = new SandboxManager();
    await manager.initialize();
    await manager.shutdown();

    const result = await manager.execute({ command: ['echo', 'again'] }, { type: 'native' });

    expect(result.success).toBe(true);
    await manager.shutdown();
  });
});
