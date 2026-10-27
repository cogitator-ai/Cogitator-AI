# @cogitator-ai/sandbox

Secure sandbox execution for Cogitator agents. Run untrusted code in isolated Docker containers, WASM modules, the operating system's own sandbox (Seatbelt on macOS, bubblewrap on Linux) or native fallback with resource limits, network isolation, and timeout enforcement, and give agents a workspace in a Docker container or in a cloud sandbox on E2B, Daytona or Vercel Sandbox.

## Installation

```bash
pnpm add @cogitator-ai/sandbox

# Optional peer dependencies
pnpm add dockerode       # For Docker sandbox
pnpm add @extism/extism  # For WASM sandbox
pnpm add e2b             # For E2BWorkspace (2.28.1 or later)
pnpm add @daytona/sdk    # For DaytonaWorkspace
pnpm add @vercel/sandbox # For VercelSandboxWorkspace
```

## Quick Start

```typescript
import { SandboxManager } from '@cogitator-ai/sandbox';

const manager = new SandboxManager();
await manager.initialize();

const result = await manager.execute(
  { command: ['python', '-c', 'print("Hello!")'] },
  { type: 'docker', image: 'python:3.11-alpine' }
);

if (result.success) {
  console.log(result.data.stdout); // "Hello!"
} else {
  console.error(result.error);
}
```

`execute()` returns a `SandboxResult`: `{ success: true, data }` or `{ success: false, error }`. A command that exits non-zero is still a success; check `data.exitCode`.

## Features

- **Docker Sandbox** - Full container isolation with dropped capabilities
- **WASM Sandbox** - Extism-powered WebAssembly execution
- **OS Sandbox** - Local commands under Seatbelt (macOS) or bubblewrap (Linux): writes only in the workspace, reads everywhere but what you deny, network only through a proxy that checks each host, the `sandbox` settings of Claude Code read as they are
- **Native Fallback** - Optional host execution for Docker tools when Docker is unavailable (`allowNativeFallback`)
- **Container Pool** - A fresh, pre-started container for every execution
- **Docker Workspace** - One long-lived container per agent workspace, the project mounted, files guarded on the host
- **Remote Workspaces** - The whole workspace in an E2B, Daytona or Vercel sandbox, with the same behavior on every provider
- **Daemon Discovery** - Finds Docker like the `docker` CLI: `DOCKER_HOST`, contexts, Docker Desktop, OrbStack, Colima, Rancher, rootless
- **Resource Limits** - Memory, CPU, PID limits
- **Network Isolation** - Disabled by default
- **Timeout Enforcement** - Kill runaway processes
- **Security Hardening** - No privilege escalation, all capabilities dropped

---

## Sandbox Manager

The `SandboxManager` orchestrates the execution backends and routes each request to the one its `type` names.

```typescript
import { SandboxManager } from '@cogitator-ai/sandbox';

const manager = new SandboxManager({
  allowNativeFallback: false,
  pool: {
    maxSize: 10,
    idleTimeoutMs: 120_000,
  },
  defaults: {
    timeout: 30_000,
    resources: {
      memory: '256MB',
      cpus: 1,
    },
    network: { mode: 'none' },
  },
});

await manager.initialize();

const result = await manager.execute(
  {
    command: ['node', '-e', 'console.log(2+2)'],
    timeout: 5000,
    env: { NODE_ENV: 'production' },
    cwd: '/workspace',
  },
  {
    type: 'docker',
    image: 'node:20-alpine',
  }
);

if (result.success) {
  console.log('Output:', result.data.stdout);
  console.log('Exit code:', result.data.exitCode);
  console.log('Duration:', result.data.duration, 'ms');
}
```

### Fallback and Initialization

`initialize()` is idempotent and safe to call concurrently; `execute()` calls it automatically.

The manager falls back in one case: a `docker` request while Docker is unavailable runs on the host through the native executor, with **no isolation**, and the first such call logs a warning. `allowNativeFallback: false` refuses those requests with `{ success: false, error }` instead, it defaults to `true`. The manager `defaults` apply to the fallback execution as well. A `wasm` request never falls back: without `@extism/extism` it fails with `WASM sandbox unavailable: install @extism/extism to run WASM tools`. An `os` request never falls back either, whatever `allowNativeFallback` says: on a machine without the OS sandbox it fails with the reason (unless its policy sets `failIfUnavailable: false`, see [OS Sandbox](#os-sandbox)).

### Finding the Docker Daemon

With `docker.socketPath` or `docker.host` (+ `port`) the executor connects there. Otherwise it tries, in order, the first that answers a ping:

1. `DOCKER_HOST` when set (handed to Dockerode, nothing else is tried)
2. The endpoint of the current Docker context (`DOCKER_CONTEXT`, else `currentContext` in `$DOCKER_CONFIG/config.json`, default `~/.docker`)
3. The sockets that exist among `/var/run/docker.sock`, `~/.docker/run/docker.sock` (Docker Desktop), `~/.orbstack/run/docker.sock` (OrbStack), `~/.colima/default/docker.sock` and `~/.colima/docker.sock` (Colima), `~/.rd/docker.sock` (Rancher Desktop) and `$XDG_RUNTIME_DIR/docker.sock` (rootless Docker)
4. Dockerode's defaults, when none of the above exists

### Availability Checks

```typescript
const dockerAvailable = await manager.isDockerAvailable();
const wasmAvailable = await manager.isWasmAvailable();
const osAvailable = await manager.isOsAvailable();

console.log('Docker:', dockerAvailable);
console.log('WASM:', wasmAvailable);
```

### Shutdown

```typescript
await manager.shutdown();
```

---

## Docker Executor

Full container isolation with security hardening.

```typescript
import { DockerSandboxExecutor } from '@cogitator-ai/sandbox';

const docker = new DockerSandboxExecutor({
  docker: {
    socketPath: '/var/run/docker.sock',
  },
  pool: {
    maxSize: 5,
    idleTimeoutMs: 60_000,
  },
});

const connectResult = await docker.connect();
if (!connectResult.success) {
  console.error('Docker not available:', connectResult.error);
}

const result = await docker.execute(
  {
    command: ['python', '-c', 'print("Hello!")'],
    stdin: 'input data',
    timeout: 10_000,
    cwd: '/app',
    env: { MY_VAR: 'value' },
  },
  {
    type: 'docker',
    image: 'python:3.11-alpine',
    timeout: 30_000,
    resources: {
      memory: '512MB',
      cpus: 2,
      pidsLimit: 50,
    },
    network: {
      mode: 'none',
    },
    mounts: [{ source: '/tmp/data', target: '/data', readOnly: true }],
    env: { GLOBAL_VAR: 'value' },
    workdir: '/workspace',
    user: 'nobody',
  }
);

await docker.disconnect();
```

### Security Features

Docker containers are created with this host configuration:

| Setting       | Value                                         |
| ------------- | --------------------------------------------- |
| `NetworkMode` | `network.mode`, default `'none'` (no network) |
| `CapDrop`     | `['ALL']` (every capability dropped)          |
| `SecurityOpt` | `['no-new-privileges']`                       |
| `PidsLimit`   | `resources.pidsLimit`, default `100`          |
| Root FS       | Writable (not configurable)                   |
| Working dir   | `/workspace`                                  |
| Label         | `ai.cogitator.sandbox=true`                   |

- `command` is executed as an argv array (no shell); use `['sh', '-c', '...']` for shell syntax.
- Output is demultiplexed frame by frame (frames split across network chunks are reassembled) and capped at 50 000 bytes per stream.
- Every execution gets a container nothing ran in before (see [Container Pool](#container-pool)); timed-out containers are always destroyed.
- `network.dns` is applied to new containers. `network.allowedHosts` is rejected because Docker cannot enforce an egress allow-list — use `mode: 'none'` or a dedicated network.
- Containers are labeled `ai.cogitator.sandbox=true` (`SANDBOX_CONTAINER_LABEL`), so leftovers from a crashed process can be removed with `docker rm -f $(docker ps -aq --filter label=ai.cogitator.sandbox)`.

---

## Container Pool

Keeps containers started ahead of executions. By default a released container is destroyed and a fresh one with the same settings is started in its place, so the next execution gets a warm container nothing ran in before — files and processes never carry over between runs or users.

```typescript
import { ContainerPool } from '@cogitator-ai/sandbox';

const pool = new ContainerPool(dockerClient, {
  maxSize: 10,
  idleTimeoutMs: 60_000,
});

const container = await pool.acquire('python:3.11-alpine', {
  memory: 256 * 1024 * 1024,
  cpus: 1,
  networkMode: 'none',
  mounts: [],
});

await pool.release(container);

await pool.destroyAll();
```

A container only serves requests with identical settings (image, resources, network mode, DNS, mounts and user), so a container created with a host mount or network access is never handed to a request that asked for isolation. `release(container, { corrupted: true })` always destroys the container. `destroyAll()` removes every container and closes the pool. The idle-cleanup timer does not keep the Node.js process alive.

### Pool Options

| Option            | Type      | Default | Description                                                                                                                                   |
| ----------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSize`         | `number`  | `5`     | Maximum idle and warming containers; no spare is started beyond it                                                                            |
| `idleTimeoutMs`   | `number`  | `60000` | Time before destroying idle containers                                                                                                        |
| `reuseContainers` | `boolean` | `false` | Return released containers to the pool as they are: faster, but what one execution leaves behind is visible to the next, from any run or user |

Pass the same options as `pool` to `SandboxManager`, `DockerSandboxExecutor` or `new Cogitator({ sandbox: { pool } })`.

---

## Docker Workspace

`DockerWorkspace` is a [workspace](https://cogitator.app/docs/tools/workspace) whose commands run in one long-lived container: created on first use (or in `start()`), kept between commands, removed in `dispose()`. The root of a host workspace (a `LocalWorkspace` from `@cogitator-ai/core`) is bind-mounted at `/workspace`, files are read and written through the host workspace and its path guard (a path under `/workspace` is mapped to the root), `remove` and `rename` run in the container where no symlink reaches the host, and commands run with `docker exec` in the matching directory. A snapshot restore removes what goes in the container too, then the host writes what changed, and is refused with `BUSY` while a command runs in the container or on the host.

```typescript
import { Agent, LocalWorkspace, workspaceTools } from '@cogitator-ai/core';
import { DockerWorkspace } from '@cogitator-ai/sandbox';

const workspace = new DockerWorkspace({
  host: new LocalWorkspace({ root: './project' }),
  image: 'node:24-alpine',
  resources: { memory: '4GB', cpus: 4 },
});
try {
  const agent = new Agent({
    name: 'coder',
    instructions: '...',
    tools: workspaceTools(),
    workspace,
  });
  await cog.run(agent, { input: 'Run the tests and fix what fails' });
} finally {
  await workspace.dispose();
}
```

The container has the security defaults of the Docker executor, an init process, limits of 2 GB, 2 CPUs and 512 processes unless `resources` sets others, no network unless `network.mode` allows it, and on Linux runs commands as your uid and gid. Each command leads its own process group: a timeout or an abort signals the group (SIGTERM, then SIGKILL after `killGrace`), background and `env -i` processes included, and the container keeps running. A process that calls `setsid` escapes the group until `dispose()`. The image needs `sh`. Starting removes containers of the same root left by a process of this machine that is gone. Without Docker the first command fails with a `WorkspaceError` of code `UNAVAILABLE`, Docker API failures come as code `IO`. `dispose()` also disposes the host workspace.

## Remote Workspaces

`E2BWorkspace`, `DaytonaWorkspace` and `VercelSandboxWorkspace` are [workspaces](https://cogitator.app/docs/tools/remote-workspaces) whose files and commands live in a cloud sandbox: created on first use (or reused by id or name), released in `dispose()`. Each needs its provider's SDK, an optional peer dependency, and credentials:

| Workspace                | Package           | Credentials                                                                   | Default root      |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------- | ----------------- |
| `E2BWorkspace`           | `e2b`             | `E2B_API_KEY`                                                                 | `/home/user`      |
| `DaytonaWorkspace`       | `@daytona/sdk`    | `DAYTONA_API_KEY` (`DAYTONA_API_URL`, `DAYTONA_TARGET`)                       | `/home/daytona`   |
| `VercelSandboxWorkspace` | `@vercel/sandbox` | Vercel's OIDC token, or `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | `/vercel/sandbox` |

```typescript
import { Agent, workspaceTools } from '@cogitator-ai/core';
import { E2BWorkspace } from '@cogitator-ai/sandbox';

const workspace = new E2BWorkspace({ root: 'project', lifetime: 30 * 60_000 });
try {
  const agent = new Agent({
    name: 'coder',
    instructions: '...',
    tools: workspaceTools(),
    workspace,
  });
  await cog.run(agent, { input: 'Clone the repo and make its tests pass' });
} finally {
  await workspace.dispose();
}
```

All three are `RemoteShellWorkspace` over a small driver (create or connect, read and write bytes, run a program, release), and everything else runs as shell scripts in the sandbox, so they behave the same:

- Paths are normalized against the root and resolved in the sandbox with `realpath -m`, a symlink out of the root is refused with `OUTSIDE_ROOT`
- Writes upload to a fresh file of the sandbox's temporary directory and move over the file in one step, keeping its mode, reads go through a private copy in the sandbox's temporary directory and never write the root, `maxFileBytes` caps both
- `list`, `remove` (with the trash in `.cogitator/trash`) and `rename` follow the `LocalWorkspace` rules, and refuse with `BUSY` while a command runs or kept background processes
- Commands run under `setsid` in their own process group, with unforgeable marker lines (the token comes on stdin): a timeout returns 124 and kills the group, `background: 'keep'` leaves background processes until `dispose()`
- `snapshot()`, `restore()`, `listSnapshots()` and `deleteSnapshot()` keep tar archives in `.cogitator/snapshots` inside the sandbox, `.cogitator`, `node_modules` and `.git` always excluded, files over `maxFileBytes` (10 MiB) skipped and listed in `skipped`, names that are not UTF-8 kept as they are, and `maxSnapshotBytes` (1 GiB) refusing a bigger one with `TOO_LARGE`. `restore(id, { dryRun })` keeps directories that hold excluded entries and files over the snapshot's size limit, and reports what it `restored`, `deleted` and `kept`, the same API as a local workspace's [file checkpoints](https://cogitator.app/docs/core/file-checkpoints)
- Reads copy at most one byte over `maxFileBytes` before they download, listings are sorted, cut at `limit` and narrowed by `glob` in the sandbox, and a command that prints more than `maxStreamBytes` (64 MiB) is stopped, because the SDKs keep whole outputs in memory
- E2B and Vercel sandboxes get a `lifetime` (30 minutes) that the workspace pushes back while it is used

`onDispose` picks what `dispose()` does with the sandbox: `destroy` (default for a created one), `stop` (Daytona and Vercel, the files survive) or `keep` (default for one given by id or name, `stop` for a named Vercel sandbox). The image needs `sh`, GNU coreutils, findutils and tar, and util-linux `setsid`, as the providers' default images have, and `start()` names what is missing. Without the SDK or the credentials the first operation fails with a `WorkspaceError` of code `UNAVAILABLE`. `e2b` needs 2.28.1 or later, and from 2.59 it needs Node.js 22.19 or later. A process that starts a session of its own (`setsid`) escapes the group kill and lives until the sandbox goes. `DaytonaWorkspace` passes `env` in a short-lived file of a private directory, so Daytona's record of the command line never holds the values.

Bring another provider by implementing `RemoteShellDriver` and passing it to `new RemoteShellWorkspace({ driver })`. `shellQuote` and `shellCommand` build a safe shell line from an argv.

## WASM Executor

Execute WebAssembly modules via Extism. Each plugin runs in its own worker thread, so a timeout terminates a runaway module instead of blocking the event loop. Idle plugins are pooled per module / WASI / allowed-host combination (up to `cacheSize`); concurrent executions use separate plugin instances.

```typescript
import { WasmSandboxExecutor } from '@cogitator-ai/sandbox';

const wasm = new WasmSandboxExecutor({
  wasm: {
    cacheSize: 10,
    wasi: true,
  },
});

await wasm.connect();

const result = await wasm.execute(
  {
    command: ['process'],
    stdin: JSON.stringify({ data: 'input' }),
  },
  {
    type: 'wasm',
    wasmModule: 'https://example.com/plugin.wasm',
    wasmFunction: 'run',
    wasi: true,
    timeout: 5000,
  }
);

await wasm.disconnect();
```

- `wasmModule` takes an `http(s)` URL, a file path or a package path:
  - a path that is absolute or starts with `.` is read relative to the working directory
  - anything else is first tried as a file relative to the working directory, then resolved like an import made by your application (for example `@cogitator-ai/wasm-tools/wasm/calc.wasm`): from the working directory, then from the entry script's directory, then from `@cogitator-ai/sandbox` itself (which covers `NODE_PATH` and hoisted installs). This works with pnpm's strict layout, where the sandbox package cannot see your dependencies.
  - when the module ships with a package that exports a path helper, such as `getWasmPath()` from `@cogitator-ai/wasm-tools`, pass that absolute path to skip resolution entirely.
- `wasmModule`, `functionName` and `wasi` from the executor options are used when the per-request config omits them.
- `network.allowedHosts` is forwarded to Extism's HTTP allow-list (empty when `network.mode` is `'none'`).
- `memoryPages` (default 256 = 16 MB) caps the module's own memory: its memory section gets that maximum before the module loads, so `memory.grow` past it fails inside the module, and a module that needs more to start is refused. Extism's memory for plugin input, output and vars gets the same limit. Modules from a URL are fetched by the executor so the cap applies to them too.

---

## OS Sandbox

`OsSandbox` runs local commands inside the operating system's sandbox, with the semantics of Claude Code's sandboxed Bash tool: Seatbelt (`sandbox-exec` with a generated profile) on macOS, bubblewrap (`bwrap`) on Linux. Linux also needs `socat`: `apt-get install bubblewrap socat`. Give it to a `LocalWorkspace` of `@cogitator-ai/core`, and every command the workspace runs (`run_command`) goes through it:

```typescript
import { LocalWorkspace, loadSandboxPolicy, workspaceTools } from '@cogitator-ai/core';
import { OsSandbox } from '@cogitator-ai/sandbox';

const { policy } = await loadSandboxPolicy('./project'); // the `sandbox` section of .claude/settings.json
const sandbox = new OsSandbox({ policy });
const workspace = new LocalWorkspace({ root: './project', exec: { sandbox } });
await workspace.start(); // fails with SANDBOX_UNAVAILABLE when the sandbox cannot run here
```

What a sandboxed command can reach:

| Access  | Default                                                                                | Change it with                                                     |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Writes  | The workspace root and the sandbox's own temporary directory, which `TMPDIR` points to | `filesystem.allowWrite`, `filesystem.denyWrite`                    |
| Reads   | Everywhere, credential files such as `~/.ssh` included                                 | `filesystem.denyRead`, `filesystem.allowRead`, `credentials.files` |
| Network | No route out but the sandbox's proxy, which allows nothing until you list hosts        | `network.allowedDomains`, `network.deniedDomains`, `onUnknownHost` |
| Env     | What the workspace passes (no API keys by default)                                     | `credentials.envVars`                                              |

- **Filesystem.** The narrower rule wins: an `allowRead` inside a wider `denyRead` reopens that part, a `denyRead` inside a wider `allowRead` still holds. A write deny always wins over an allow. Paths are absolute, `~/` for the home directory, or relative to the workspace root. `*`, `?`, `**` and `[...]` work in every list on macOS and in the read lists on Linux, a trailing `/**` everywhere.
- **Protected paths.** Even inside a writable directory a command cannot write the settings, hooks, skills, agents, commands and plugins of Claude Code and Cogitator (in the root and every directory above it, and `~/.claude`, `~/.cogitator`, `~/.claude.json`), the whole `.cogitator` directory of the root (its trash and snapshots), `.mcp.json`, shell startup files, `.gitconfig`, `.gitmodules`, `.vscode`, `.idea`, the repository's `.git/hooks` and `.git/config` (of the main repository too for a linked worktree), and a `HEAD` at the root, so no command turns the root into a bare repository whose config git outside the sandbox would read. A symlink at a protected path protects its target too. Only `filesystem.disabled` lifts them, with the rest of filesystem isolation.
- **Network.** Commands get `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (SOCKS5) pointing at a proxy that serves that command alone. A host `deniedDomains` names is refused, one `allowedDomains` names goes through (`github.com` that host only, `*.npmjs.org` its subdomains, `*` every host, IPv4 and bracketed IPv6 addresses, each with an optional `:port`), and any other host is decided by the call's `onUnknownHost` (a run wires it to its permissions as a `WebFetch(domain:...)` call), else the sandbox's own `onUnknownHost`, else refused. `strictAllowlist` refuses unknown hosts without asking. A host name that resolves only to loopback, link-local, a cloud metadata endpoint or an address of this machine is refused, `localhost` aside, list the address itself (`127.0.0.1:3000`) to reach a local server by name. UDP, QUIC and ICMP do not leave, and tools that ignore the proxy variables (plain `ssh`, most database drivers) cannot connect.
- **Per-command hosts.** `exec(command, { allowedDomains })` (and `run_command`'s `allowedDomains`) opens hosts for that command alone, while it runs, and a host it does not list is then refused without asking. `deniedDomains` still wins, and a `strictAllowlist` policy refuses such a call.
- **Violations.** What the proxy refused, and the file accesses the system refused (`Operation not permitted`, `Read-only file system`), are attributed to the command: `result.sandbox.violations`, and a sanitized `<sandbox_violations>` block appended to its stderr, so the model sees why it failed. `ignoreViolations` silences the expected ones (`{ "*": ["/etc/hosts"] }`).
- **Outside the sandbox.** `excludedCommands` (the content of `Bash(...)` rules, such as `docker *`) run unsandboxed when every command of the line matches and the line has no redirection, `cd`, substitution or program from a variable. `dangerouslyDisableSandbox` on a call runs it unsandboxed only when the policy sets `allowUnsandboxed` (default false, ignored otherwise). Both go through the normal permission flow, and the result says `sandboxed: false` with the reason.
- **Unavailable.** `failIfUnavailable` (default true) refuses to start, with a `SANDBOX_UNAVAILABLE` error naming why: no `sandbox-exec`, no `bwrap` or `socat`, user namespaces blocked (a container, Ubuntu's AppArmor restriction). With `false` commands run unsandboxed with a warning, and each result says so (`unsandboxedReason: 'unavailable'`). There is no silent fallback.
- **Permissions.** A command that runs inside skips the approval it would need (`autoAllow`, default true): `run_command`'s own and a bare `Bash` ask rule. Deny rules, ask rules with a pattern (`Bash(git push *)`), `rm` and `rmdir` of a critical path (the root, `~`, `/`, `.git`) and plan mode still apply, and a command with `VAR=x` in front, `eval` or `make X=y` goes through the normal flow, as do commands that name hosts of their own.

`OsSandbox.probe()` says whether the sandbox runs here, `OsSandbox.create(options)` returns a started one, `dispose()` closes the proxies of commands still running and removes its directories. The `os` type of the `SandboxManager` runs an execution under it (`{ type: 'os', workdir, os: policy }`, the workdir its writable root).

Not covered, honestly: shell `rm` deletes for good (the trash is the `delete_file` tool's, see `@cogitator-ai/core`), processes a command leaves running in the background lose the network once it exits (and are stopped with it on Linux), Seatbelt violations are read from the command's errors, not from the system log, Linux denies paths a wildcard matches when the command starts (a file made later is not covered), Linux does not filter Unix sockets (no seccomp filter), and no TLS is inspected, so an allowed domain carries whatever goes to it.

---

## Native Executor

Direct execution without isolation (fallback mode).

```typescript
import { NativeSandboxExecutor } from '@cogitator-ai/sandbox';

const native = new NativeSandboxExecutor();
await native.connect();

const result = await native.execute(
  {
    command: ['ls', '-la'],
    cwd: '/tmp',
    env: { LC_ALL: 'C' },
    timeout: 5000,
  },
  { type: 'native' }
);

if (result.success) console.log(result.data.stdout);
```

**Warning:** Native execution has no isolation. Use only when Docker is unavailable.

- A single-element command (`['ls -la | wc -l']`) runs through the system shell; longer commands are executed directly with exact argv (no shell), like Docker.
- `stdin` is piped to the process.
- Only `PATH`, `HOME`, temp-dir, locale and Windows system variables are inherited from the host environment; secrets in `process.env` are not passed to executed code. Add variables explicitly via `env`.
- On timeout the whole process group is killed (`SIGKILL`) and the result is returned immediately with exit code `124`.
- Output is capped at 50 000 bytes per stream while the process is still drained.

---

## Execution Request

```typescript
interface SandboxExecutionRequest {
  command: string[];
  stdin?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}
```

### Cancelling an Execution

Aborting `signal` stops the execution right away: the native executor kills the process group, the Docker executor ends the exec and removes its container (an aborted container is never reused), and the WASM executor closes the plugin, which ends its worker. The result is a failure that names the reason, and a signal that is already aborted runs nothing. Cogitator passes the run's signal, so cancelling a run stops its sandboxed tools.

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(new Error('user cancelled')), 1000);

const result = await manager.execute(
  { command: ['sleep', '30'], signal: controller.signal },
  { type: 'docker', image: 'alpine:3.19' }
);
// { success: false, error: 'Execution aborted: user cancelled' }
```

## Execution Result

```typescript
interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  duration: number;
  truncated?: boolean;
}
```

---

## Resource Limits

### Memory

```typescript
const result = await manager.execute(request, {
  type: 'docker',
  image: 'alpine',
  resources: {
    memory: '256MB',
  },
});
```

Supported formats: `'256B'`, `'256KB'`, `'256MB'`, `'1GB'`, `'1TB'`, Docker-style `'512m'` / `'2g'` and binary `'1GiB'` (all binary multiples, case-insensitive). Zero or negative memory and CPU limits are rejected instead of silently running unlimited.

### CPU

`SandboxConfig` is exported as a type (`import type { SandboxConfig } from '@cogitator-ai/sandbox'`).

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  resources: {
    cpus: 0.5,
    cpuShares: 512,
  },
};
```

### Process Limits

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  resources: {
    pidsLimit: 50,
  },
};
```

---

## Network Configuration

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  network: {
    mode: 'none',
  },
};
```

Network modes:

- `'none'` - No network access (default, most secure)
- `'bridge'` - Docker bridge network
- `'host'` - Host network (not recommended)

---

## Volume Mounts

Mount host directories into the container:

```typescript
const config: SandboxConfig = {
  type: 'docker',
  image: 'alpine',
  mounts: [
    { source: '/host/data', target: '/data', readOnly: true },
    { source: '/host/output', target: '/output', readOnly: false },
  ],
};
```

---

## Utility Functions

### Parse Memory

```typescript
import { parseMemory } from '@cogitator-ai/sandbox';

parseMemory('256MB');
parseMemory('1GB');
parseMemory('512KB');
```

### CPU to NanoCPUs

```typescript
import { cpusToNanoCpus } from '@cogitator-ai/sandbox';

cpusToNanoCpus(0.5);
cpusToNanoCpus(2);
```

---

## Type Reference

```typescript
import type {
  SandboxType,
  SandboxConfig,
  SandboxResourceLimits,
  SandboxNetworkConfig,
  SandboxMount,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerConfig,
  SandboxPoolConfig,
  SandboxDockerConfig,
  SandboxResult,
  OsSandboxPolicy,
  OsSandboxKind,
  OsSandboxAvailability,
  SandboxViolation,
  SandboxHostRequest,
  SandboxHostDecider,
} from '@cogitator-ai/sandbox';
```

---

## Integration with Cogitator

Use sandboxed tools in your agents:

```typescript
import { Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const shellTool = tool({
  name: 'run_shell',
  description: 'Execute shell commands safely',
  parameters: z.object({
    command: z.string(),
  }),
  sandbox: {
    type: 'docker',
    image: 'ubuntu:22.04',
    resources: { memory: '256MB' },
    network: { mode: 'none' },
  },
  timeout: 30000,
  execute: async ({ command }) => command,
});

const cog = new Cogitator({
  sandbox: {
    pool: { maxSize: 5 },
    allowNativeFallback: false,
  },
});
```

The runtime starts a `SandboxManager` from `new Cogitator({ sandbox })` on the first sandboxed tool call. For a Docker tool it does not call `execute`: the sandbox runs the tool's `command` argument with `sh -c` (with optional `cwd` / `env` arguments) and the output becomes the tool result. A WASM tool gets its arguments as JSON on stdin and its JSON stdout is the result. When Docker is unavailable — or this package is missing or fails to start — a Docker tool runs its `execute` unsandboxed on the host with a warning, unless `sandbox.allowNativeFallback: false` turns the call into a tool error. A WASM tool fails when Extism is missing, and runs its own `execute` only when this package is missing or fails to start. See [Sandbox](https://cogitator.app/docs/deployment/sandbox) on the website.

---

## Examples

### Run Python Code

```typescript
const result = await manager.execute(
  {
    command: [
      'python',
      '-c',
      `
import json
data = {"sum": 2 + 2}
print(json.dumps(data))
    `,
    ],
  },
  {
    type: 'docker',
    image: 'python:3.11-alpine',
    timeout: 10_000,
  }
);

if (result.success) {
  const output = JSON.parse(result.data.stdout);
  console.log(output.sum);
}
```

### Run Node.js Code

```typescript
const result = await manager.execute(
  {
    command: ['node', '-e', 'console.log(JSON.stringify({result: 42}))'],
  },
  {
    type: 'docker',
    image: 'node:20-alpine',
    resources: { memory: '128MB' },
  }
);
```

### Run Shell Commands

```typescript
const result = await manager.execute(
  {
    command: ['sh', '-c', 'ls -la /workspace && pwd'],
    cwd: '/workspace',
  },
  {
    type: 'docker',
    image: 'alpine:3.19',
  }
);
```

### Handle Timeouts

```typescript
const result = await manager.execute(
  { command: ['sleep', '60'] },
  { type: 'docker', image: 'alpine', timeout: 5000 }
);

if (result.success && result.data.timedOut) {
  console.log('Command timed out');
}
```

### Check Exit Codes

```typescript
const result = await manager.execute(
  { command: ['sh', '-c', 'exit 42'] },
  { type: 'docker', image: 'alpine' }
);

if (result.success) console.log('Exit code:', result.data.exitCode);
```

---

## License

MIT
