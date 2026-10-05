# @cogitator-ai/neuro-symbolic

## 17.0.13

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/core@0.30.1

## 17.0.12

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0

## 17.0.11

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0

## 17.0.10

### Patch Changes

- [#110](https://github.com/cogitator-ai/Cogitator-AI/pull/110) [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406) - Close the code scanning findings that were real. `webScrape` reads HTML with a linear tokenizer instead of chained regular expressions, so a hostile page can no longer block the event loop (200 KB of unclosed tags took over 20 seconds). It decodes each entity once (an escaped `&amp;lt;` no longer turns into `<`), treats `script` and `style` content as raw text the way browsers do, keeps a `>` inside a quoted attribute in its tag, matches `.class` selectors by class name and nested elements by depth, puts multi-line link text on one line, and drops `javascript:`, `data:` and `vbscript:` links in any letter case. A run or swarm timeout beyond what a timer can hold (about 24.8 days) no longer aborts the run at once, and the HTTP adapters refuse such a swarm `timeout` with 400. The `random_string` tool picks characters without modulo bias. Regular expressions that ran in polynomial time on crafted input (env interpolation, JSON fences, model ids, the injection classifier, the knowledge graph query tokenizer and others) are now linear. The a2a error log passes its context as an argument instead of building the format string from it.
- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/types@0.31.0

## 17.0.9

### Patch Changes

- [`e1f9192`](https://github.com/cogitator-ai/Cogitator-AI/commit/e1f919218e385f927c8bc05fda59718541c1dcd0) - `PostgresGraphAdapter.searchNodesSemantic()` finds every matching node. `connect()` built an `ivfflat` index on the still empty `graph_nodes` table, and once Postgres used it, searches missed nodes (a search for 60 nodes in a graph of 3000 returned 31, and with the index forced a search for 10 returned none). The adapter now builds an HNSW index, which needs no training data, and replaces an existing `ivfflat` index on the first `connect()` after upgrading. On a large graph that rebuild takes a while, the README shows how to build the index ahead of the deploy. Searches also raise `hnsw.ef_search` to the requested limit and use iterative scans on pgvector 0.8+, so a limit above 40 or an `entityTypes` filter no longer cuts results short, and equally similar nodes come back ordered by id. A failed search now returns a failed result instead of throwing.
- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/types@0.30.0

## 17.0.8

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2

## 17.0.7

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1

## 17.0.6

### Patch Changes

- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 17.0.5

### Patch Changes

- 0ef09fc: `NeuroSymbolic.getConfig()` returns `ResolvedNeuroSymbolicConfig`, where every section (`logic`, `constraints`, `planning`, `knowledgeGraph`) is present, as it always was at runtime; callers no longer need optional chaining to read it.
- Updated dependencies [e211b6a]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/types@0.28.0

## 17.0.4

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0

## 17.0.3

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0

## 17.0.2

### Patch Changes

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0

## 17.0.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1

## 17.0.0

### Major Changes

- Optional z3-solver accepts 4 and 5.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

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
