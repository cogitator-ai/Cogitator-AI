# @cogitator-ai/neuro-symbolic

## 16.0.0

### Major Changes

- Two critical bugs fixed. First, Prolog operator precedence was inverted, so text rules with arithmetic were wrong: `X is 2 + 3 * 4` parsed as `(X is 2) + ...`. Second, the Z3 backend never worked: it called a non-existent `solver.setTimeout`, so the default `solve()` returned `status: 'error'` whenever z3-solver was installed. Logic module: the parser was rewritten in ISO style (shared operator table, functional notation, `?`/`?-` queries, real error positions). The resolver was rewritten with cut barriers, so cut is now local to its clause and if-then-else commits to its condition; added findall/forall/between/call/not. Arithmetic now follows ISO semantics (mod, //). termToString output now parses back to the same term, and applySubstitution no longer stops at depth 100. Z3 solver rewritten against the real z3-solver API: Int/Real mixing, bit-vectors, soft constraints, timeouts. The built-in SAT solver now proves unsat and finds optimal objectives on finite domains. Graph queries: fixed a join bug that returned results when an earlier pattern had no matches, removed the silent 1000-node limit, and implemented bidirectional edges, type predicates and describe. The query-string parser was rewritten because single-line queries and FILTER/ORDER BY were ignored. Natural-language queries fixed (word matching, relation mapping, count). Graph adapters now limit shortest-path and traversal to the requesting agent; also fixed the traverse limit, a merge that deleted the target node, and a Neo4j LIMIT float error. Planning: ordering-threat detection was dead code and is now implemented; precondition checks compare values deeply; repair suggestions are checked by simulation. Orchestrator: config fields that were ignored now take effect, async calls return error results instead of throwing, and validateAndRepair checks invariants on the final plan. README and docs page rewritten (most of their examples did not match the real API); example extended.

  **Breaking changes**
  - Prolog text now parses with ISO precedence: `X is 2 + 3 * 4` gives 14; the old parser produced `(X is 2) + ...`
  - Cut is local to its clause and if-then-else commits to its condition (previously cut pruned ancestor alternatives, and else ran when then failed)
  - `mod` follows the sign of the divisor and `//` truncates toward zero
  - Variables starting with `_` (including anonymous `_`) are no longer included in query solutions
  - createKnowledgeBase(program) throws on syntax errors; parseClause fails on trailing input after the first clause
  - NeuroSymbolic.repairPlan().success is false when the repair fails (data still contains suggestions); validateAndRepair().success requires invariants to hold on the final plan
  - GraphAdapter.getNeighbors('outgoing'/'incoming') in the memory/postgres/neo4j adapters includes bidirectional edges from the other direction (aligned with @cogitator-ai/memory); findShortestPath/traverse enforce agentId
  - termToString quotes atoms that need it and prints operators infix
  - applySubstitution(term, subst) no longer accepts a third depth argument
  - Graph tools use NeuroSymbolicToolsOptions.agentId when given; otherwise they use the tool context agentId as before

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 15.1.16

### Patch Changes

- Comprehensive audit: ~560 bugs fixed across 16 packages

  Second-pass audit of all major packages with deep source review,
  automated fixes, and test updates. Key security fixes include SSRF
  protection (rag, a2a), sandbox escape prevention via worker_threads
  (self-modifying), broken MD5/Ed25519 crypto (wasm-tools), prototype
  chain bypass (server adapters), and MCP input schema validation.
  - memory: 58 fixes (adapters try/catch, embedding retry/timeout, knowledge graph UNION ALL, BM25 inverted index)
  - workflows: ~100 fixes (concurrency enforcement, cancel/abort wiring, cron double-fire race, setTimeout overflow)
  - swarms: ~70 fixes (Redis atomic writes via Lua, pipeline goto guard, approval Promise hang, delegation race)
  - rag: 31 fixes (SSRF protection, PDF splitPages rewrite, recursive chunker offsets, MMR lambda wiring)
  - a2a: 24 fixes (busy-loop fix, HMAC nested fields, SSRF IPv6 bypass, auth enforcement, Redis atomic update)
  - voice: 45 fixes (VAD race serialization, Deepgram timeout, TTS safe body access, SileroVAD dispose)
  - browser: 41 fixes (stealth flags controllable, smartSelect crash, path traversal, screenshot dimensions)
  - neuro-symbolic: 58 fixes (semicolon lexer, PRNG OOB, Ed25519 curve math, extractJSON string-aware, plan repair)
  - self-modifying: 63 fixes (worker_threads sandbox, safety constraints enforced, dead triggers wired, shouldAdopt logic)
  - wasm-tools: 27 fixes (MD5 BigInt padding, CSPRNG keygen, plugin leak, extism API fix, serialization queue)
  - mcp: 17 fixes (per-request transport, Zod raw shape inputSchema, body size limit, callTool all content blocks)
  - server adapters: 26 fixes (Object.hasOwn prototype bypass, error masking, abort signal, CORS credentials)
  - types: allowReverseTraversal, baseUrl, dimensions fields added
  - CI: retired models updated, http.test.ts mocked, TEST_MODEL upgraded to gpt-oss:20b

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3

## 15.1.15

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/memory@0.6.21

## 15.1.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/memory@0.6.20

## 15.1.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/memory@0.6.19

## 15.1.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 15.1.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 15.1.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/memory@0.6.17

## 15.1.9

### Patch Changes

- @cogitator-ai/memory@0.6.16
- @cogitator-ai/core@0.18.4

## 15.1.8

### Patch Changes

- @cogitator-ai/core@0.18.3

## 15.1.7

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.14
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 15.1.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 15.1.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/memory@0.6.13

## 15.1.3

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/types@0.19.2
  - @cogitator-ai/memory@0.6.11

## 15.1.2

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/types@0.19.1
  - @cogitator-ai/memory@0.6.10

## 15.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 15.1.0

### Minor Changes

- Add PostgreSQL and Neo4j graph adapters for persistent knowledge graphs
- Add PostgreSQL and Neo4j graph adapters for persistent knowledge graphs

## 15.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.19.0
  - @cogitator-ai/core@0.17.1
  - @cogitator-ai/memory@0.6.9

## 15.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/types@0.18.0
  - @cogitator-ai/memory@0.6.8

## 14.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/types@0.17.0
  - @cogitator-ai/memory@0.6.7

## 13.0.1

### Patch Changes

- feat: distributed swarm execution via Redis

## 13.0.0

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/types@0.16.0
  - @cogitator-ai/memory@0.6.6

## 12.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/types@0.15.0
  - @cogitator-ai/memory@0.6.5

## 11.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/types@0.14.0
  - @cogitator-ai/memory@0.6.4

## 10.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/types@0.13.0
  - @cogitator-ai/memory@0.6.3

## 9.1.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/memory@0.6.2
  - @cogitator-ai/core@0.11.5

## 9.1.0

### Minor Changes

- feat: implement agent tools for formal reasoning

  Add `createNeuroSymbolicTools()` factory that exposes neuro-symbolic capabilities as tools that agents can use:

  **Logic tools:**
  - `queryLogic` - Execute Prolog-style queries with variable bindings
  - `assertFact` - Add facts/rules to the knowledge base
  - `loadProgram` - Load complete Prolog programs

  **Constraint tools:**
  - `solveConstraints` - Solve SAT/SMT problems with Z3 or simple solver

  **Planning tools:**
  - `validatePlan` - Verify action sequences against preconditions
  - `repairPlan` - Suggest fixes for invalid plans
  - `registerAction` - Define action schemas for planning

  **Graph tools** (when graphAdapter provided):
  - `findPath` - Find shortest paths in knowledge graphs
  - `queryGraph` - Pattern match against graph nodes/edges
  - `addGraphNode` - Add entities to the knowledge graph
  - `addGraphEdge` - Add relationships between entities

  Also adds `MemoryGraphAdapter` - full in-memory GraphAdapter implementation for testing and development.

## 9.0.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.12.0
  - @cogitator-ai/core@0.11.4
  - @cogitator-ai/memory@0.6.1

## 9.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.11.0
  - @cogitator-ai/memory@0.6.0
  - @cogitator-ai/core@0.11.3

## 8.0.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.10.1
  - @cogitator-ai/core@0.11.2
  - @cogitator-ai/memory@0.5.2

## 8.0.1

### Patch Changes

- @cogitator-ai/core@0.11.1

## 8.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0

## 7.0.0

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/types@0.10.0
  - @cogitator-ai/memory@0.5.1

## 6.0.0

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.9.0
  - @cogitator-ai/memory@0.5.0
  - @cogitator-ai/core@0.9.0

## 5.0.0

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/types@0.8.1
  - @cogitator-ai/memory@0.4.3

## 4.0.0

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/types@0.8.0
  - @cogitator-ai/memory@0.4.2

## 3.0.1

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 3.0.0

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/types@0.7.0
  - @cogitator-ai/memory@0.4.1

## 2.0.1

### Patch Changes

- 004cce0: Add negation-as-failure operator (\+) support in Prolog-like parser

## 2.0.0

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/memory@0.4.0
  - @cogitator-ai/types@0.6.0

## 1.0.0

### Minor Changes

- 05de0f1: feat(neuro-symbolic): add neuro-symbolic AI package
- fb21b64: feat(neuro-symbolic): add neuro-symbolic AI package

  Introduce @cogitator-ai/neuro-symbolic - a hybrid neural-symbolic reasoning package with four modules:

  **Logic Programming**
  - Prolog-style parser and knowledge base
  - Robinson unification algorithm
  - SLD resolution with backward chaining
  - Built-in predicates (member, append, findall, etc.)
  - Proof tree generation and visualization

  **Knowledge Graph Queries**
  - SPARQL-like query builder with fluent API
  - Natural language query interface
  - Multi-hop reasoning engine
  - Transitive, inverse, and composition inference

  **Constraint Solving**
  - Fluent DSL for building constraint problems
  - Z3 WASM solver integration (optional)
  - Pure TypeScript SAT solver fallback
  - Support for bool, int, real, bitvec variables
  - Global constraints (allDifferent, atMost, atLeast)

  **Plan Verification**
  - PDDL-like action schema builder
  - Plan validation with precondition/effect checking
  - Safety property verification (invariant, eventually, always, never)
  - LLM-assisted plan repair
  - Dependency graph analysis

### Patch Changes

- Updated dependencies
- Updated dependencies [05de0f1]
- Updated dependencies [fb21b64]
- Updated dependencies [05de0f1]
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/types@0.5.0
  - @cogitator-ai/memory@0.3.1
