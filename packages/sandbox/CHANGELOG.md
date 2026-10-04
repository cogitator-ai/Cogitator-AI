# @cogitator-ai/sandbox

## 0.5.1

### Patch Changes

- [`e150c83`](https://github.com/cogitator-ai/Cogitator-AI/commit/e150c83e8c9dc1bd9961d0a3413cf31d0d9175f1) - A WASM module given as a package path, such as `@cogitator-ai/wasm-tools/wasm/calc.wasm`, now resolves from your application. The executor resolved it from `@cogitator-ai/sandbox` itself, which does not depend on the package that ships the module, so with pnpm's strict layout (or any install that does not hoist) the call failed with `WASM module not found` unless a launcher happened to set `NODE_PATH`. Package paths are now resolved from the working directory, then from the entry script's directory, then from the sandbox package as before. Relative paths are read from the working directory, and a module that cannot be found is reported with the directory it was looked up from.
- Updated dependencies [[`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/types@0.30.0

## 0.5.0

### Minor Changes

- db2e373: Sandbox fallbacks are explicit and safe. `sandbox.allowNativeFallback: false` refuses to run Docker-sandboxed tools on the host when Docker is unavailable (the fallback stays on by default, with a loud warning). WASM tools no longer fall back to Docker or native execution, which failed with "Command array is empty". Every Docker execution now gets a container no code ran in before (a fresh one is kept warm), so files and processes cannot leak between runs or users; `pool.reuseContainers: true` restores reuse.

### Patch Changes

- db2e373: The Docker executor finds the daemon the way the `docker` CLI does: it tries the endpoint of the current Docker context (`DOCKER_CONTEXT` or `~/.docker/config.json`), then the sockets of Docker Engine, Docker Desktop, OrbStack, Colima, Rancher Desktop and rootless Docker, so `isDockerAvailable()` no longer reports `false` when only a non-default context is running.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [ae26101]
  - @cogitator-ai/types@0.29.0

## 0.4.4

### Patch Changes

- b8c7c3d: `memoryPages` now limits the WASM module's own memory, not only the memory Extism uses for input and output: the module's memory section gets that maximum before it loads, so `memory.grow` past it fails inside the module, and a module that needs more to start is refused. Modules given by URL are fetched by the executor so the limit applies to them as well.
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [57ac053]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/types@0.28.0

## 0.4.3

### Patch Changes

- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/types@0.27.0

## 0.4.2

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0

## 0.4.1

### Patch Changes

- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [f36a121]
  - @cogitator-ai/types@0.25.0

## 0.4.0

### Minor Changes

- `wasm.memoryPages` caps Extism's allocations; dockerode 5 (peer range ^4 || ^5).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.24.0

## 0.3.0

### Minor Changes

- `wasm.memoryPages` (default 256 = 16 MB) is now passed to Extism as `memory.maxPages`, capping the memory Extism allocates for plugin input, output and vars. It was previously ignored.
- The WASM executor could not load any local module: it passed a raw Buffer as the Extism manifest ("Expected wasm key in manifest", reproduced). Its timeouts could never stop a spinning module, and concurrent calls hit 'plugin is not reentrant'. Rewritten: correct manifests, a worker per plugin (runInWorker) terminated on timeout, a per-key plugin pool with LRU, and executor-level defaults and allowedHosts honored. The native executor ran join(' ') through the shell. That broke argument boundaries (the package's own example failed with a shell syntax error), allowed shell injection through args, passed the full host process.env (secrets) to executed code, ignored stdin, and hung on grandchildren after a timeout. Fixed: exact argv for multi-element commands (single-element commands still use the shell), minimal env, stdin piped, whole process group killed. Docker fixes: the pool reused containers across different security settings (host mounts or bridge network handed to an isolated request); multiplexed frames split across chunks were dropped; host config ignored DOCKER_HOST; network.allowedHosts was silently ignored (now rejected), dns wired; 0MB/negative limits silently ran unlimited (now rejected); containers that failed to start leaked; the cleanup interval kept the process alive; containers are now labeled. Manager: concurrent initialize() created duplicate executors; fallbacks skipped the manager defaults.

  **Breaking changes**
  - NativeSandboxExecutor: multi-element commands run with exact argv and no shell (e.g. ['echo', '$VAR'] no longer expands; use ['echo $VAR'] or ['sh','-c',...]). Only PATH/HOME/temp/locale/Windows system variables are inherited from process.env.
  - DockerSandboxExecutor: network.allowedHosts is rejected with an error instead of being ignored. Zero/negative memory or CPU limits are rejected. Without docker options, Dockerode defaults (DOCKER_HOST) are used instead of a hard-coded /var/run/docker.sock.

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.23.0

## 0.2.29

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.3

## 0.2.28

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.

## 0.2.27

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.2

## 0.2.26

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.22.1

## 0.2.25

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3

## 0.2.24

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.2.23

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.2.21

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.2.20

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.2.19

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.2.16

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.2.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

## 0.2.9

### Patch Changes

- abdafa3: fix: properly terminate Docker containers on timeout

  Previously, when a timeout occurred in Docker executor, only a flag was set but the exec process continued running in the background. Now:
  - Uses Promise.race to immediately resolve on timeout
  - Closes stream when timeout fires
  - Marks timed-out containers as corrupted so they're destroyed instead of returned to pool
  - Uses exit code 124 (standard timeout exit code)

## 0.2.8

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/types@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/types@0.8.1

## 0.2.5

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/types@0.8.0

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/types@0.7.0

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.4.0

## 0.2.0

### Minor Changes

- Add error logging for Docker/WASM initialization failures in SandboxManager
- Add error logging for container stop/remove failures in ContainerPool
- Add error logging for WASM plugin close failures
- Fix WASM cache cleanup: plugin entries now deleted even if close() throws
- Add command validation in native and docker executors (reject empty arrays)

### Tests

- Add test for empty command array validation

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
