# @cogitator-ai/redis

## 0.4.0

### Minor Changes

- ioredis 6 (peer range ^5 || ^6).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

## 0.3.0

### Minor Changes

- keys() ignored keyPrefix: the pattern was not prefixed and the results came back prefixed, so del(...keys) prefixed them twice and deleted nothing. The dashboard's invalidateCache never worked and the e2e cleanup leaked its keys. keys() now prefixes the glob-escaped pattern and strips the prefix from results. It also uses SCAN instead of the blocking KEYS command and covers every master in cluster mode. subscribe() matched channels with endsWith, so 'events' also received 'user-events'; matching is now exact. A second callback on the same channel overwrote and leaked the first; callbacks are now kept per channel and unsubscribe removes them all. A malformed REDIS_CLUSTER_NODES used to fall back silently to localhost and now throws. An empty cluster node list and a missing ioredis now give clear errors. README and the deployment docs were corrected: backoff wording, hash tags, a snippet that did not type-check, keys and pub/sub semantics, and the claim that worker uses this client. ioredis behaviour was verified against a live Redis 7.

  **Breaking changes**
  - RedisClient.keys() results are relative to keyPrefix (previously returned prefixed keys that could not be used with get/del); unchanged when no prefix
  - subscribe callbacks no longer fire for channels that merely end with the subscribed name
  - createConfigFromEnv throws when REDIS_CLUSTER_NODES is set but malformed instead of falling back to standalone localhost

## 0.2.24

### Patch Changes

- fix(redis): subscribe memory leak, keyPrefix channel matching, remove dead code
  - Fix subscribe handler leak: unsubscribe now properly removes message handlers
  - Fix channel matching with keyPrefix: subscribe callback now fires correctly when keyPrefix is set
  - Remove unused QueueMetrics (duplicated in worker), unused @cogitator-ai/types dep
  - Move @types/node to devDependencies

## 0.2.23

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1

## 0.2.22

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/types@0.20.0

## 0.2.20

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/types@0.19.2

## 0.2.19

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/types@0.19.1

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.18.0

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.17.0

## 0.2.15

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/types@0.16.0

## 0.2.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.15.0

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.14.0

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.13.0

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0

## 0.2.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1

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

- Fix subscribe callback: now properly invokes callback with (channel, message) on received messages
- Improve type safety: `any[]` → `unknown[]` for event callbacks
- Add typed overloads for common events (message, error, connect, etc.)
- Add port validation in `createConfigFromEnv()` (NaN defaults to 6379)

### Tests

- Add comprehensive tests for `parseClusterNodesEnv()`
- Add comprehensive tests for `createConfigFromEnv()`

## 0.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.2.0
