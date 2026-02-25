# Audit: @cogitator-ai/neuro-symbolic

Started: 2026-02-25

## Status

**Complete**
Last updated: 2026-02-25

## Summary

- **Total issues found:** ~100 across 35 source files
- **All issues fixed** (2 passes: initial 40+, then remaining 35+)
- **Tests:** 377 (10 files) — all pass
- **Build:** PASS | **Lint:** 0 errors

## Completed Steps

### 1. Build — PASS

### 2. Lint — PASS

### 3. Remove comments — PASS

### 4. Full source review — ALL issues fixed

#### Pass 1: Critical bugs (40+ fixes)

**constraints/**

- Division by zero in `div`/`mod` — returns null
- `not` operator coercing numbers — strict boolean check
- `ite` using JS truthiness — strict `=== true`
- bitvec off-by-one — inclusive upper bound

**logic/**

- Division by zero in arithmetic — throws error
- `==`/`\==` string comparison — uses `termsEqual()`
- `getBuiltinList()` stale list — reads from builtins Map
- `applySubstitution` infinite loop — depth limit
- Block comment off-by-one, unterminated strings
- `getRelevantBindings` underscore filter
- Dead code: `importParser`, `ResolverState.cut`

**knowledge-graph/**

- BFS traverse missing visited start node — all 3 adapters
- `formatResultAsNaturalLanguage` unreachable "No"
- SQL injection via schema name — validation
- ReDoS via regex — length limits + try/catch
- `getNeighbors` inflating access_count — aliased JOIN
- `calculatePathConfidence` weight semantics

**planning/**

- `exists`/`forall` hardcoded values — implemented
- `reorderActions` no-op — implemented swap
- `attemptRepair` stale baseline — tracks current count
- `findParallelizable` — checks all group members
- `producedBy` overwriting — tracks all producers
- `until` safety property — state trace walk
- Config flags ignored — now filter properties

**tools/ + orchestrator**

- `solve()` marking unsat as failure — success:true
- `getConfig()` leaking config — deep copy
- Config restore on throw — try/finally
- `parseOperand` partial numeric — Number()
- Missing objective variable — returns error
- `formatPath` crash — bounds check
- ReDoS via namePattern — max(200) Zod

#### Pass 2: All remaining issues (35+ fixes)

**constraints/**

- Z3 soft constraints dropped — add_soft() via Optimizer
- Z3 missing abs/min/max — If() expressions
- Z3 constants always Int — Number.isInteger check for Real
- Z3 module caching retry — removed error cache
- Simple-SAT ignores optimization — tracks best satisfying assignment
- randomSeed never used — seeded PRNG (LCG) threaded through
- ConstraintBuilder.clone() shallow — deep copy vars/constraints
- Greedy JSON regex — balanced brace extraction (all 4 prompts.ts files)
- parseNLConstraintsResponse unsafe type cast — validated

**logic/ (MAJOR: infix operator support)**

- Full Prolog infix operator parsing via precedence climbing
  - Lexer: operator token type, multi-char operators (=:=, \==, etc.)
  - Parser: Pratt parsing with standard Prolog precedence
  - Handles: `X is 1 + 2`, `X > 3`, `X = Y`, `A mod B`, etc.
- List unification substitution threading
- If-then (`->`) binding loss — captures full substitution
- nth0/nth1 integer check — Number.isInteger()
- sort/msort standard order — numeric comparison, term ordering
- Mermaid escapeLabel — escapes []{}()<>|# chars
- termFromValue prototype pollution — filters **proto** keys

**knowledge-graph/**

- Cypher injection — parameterized $queryLimit
- mergeNodes edge corruption — collect-then-modify
- getNodeByName updates all rows — LIMIT 1 subquery
- findShortestPath/searchNodesSemantic catch too broadly — specific error matching
- mergeNodes transactional — BEGIN/COMMIT/ROLLBACK (Postgres), executeWrite (Neo4j)
- Duplicated cosineSimilarity — extracted to utils.ts
- analyzeNLQuery entity matching — expanded stop words (40+)
- pgvector embedding parsing — JSON.parse string fallback
- parseQueryString variable-only subjects — accepts literals too

**planning/**

- Comparison operators unsafe casts — typeof validation
- increment/decrement no-op on non-numeric — initializes from 0
- inferParameterValue random match — name-based heuristic
- suggestReorders O(n²) — cached error count
- schemaCouldEstablish assign-only — checks all effect types
- commonSafetyProperties null crash — value validation
- detectOrderingIssues indexOf — Map-based lookup
- parsePlanResponse validation — Array.isArray + filter
- Greedy JSON regex — balanced brace extraction

### 5-15. All pass

Exports, dependencies, tests (377), E2E, README, root README, docs site, examples, CLAUDE.md — all verified.

## Architecture Notes

- New file: `knowledge-graph/utils.ts` — shared cosineSimilarity, extractJSON
- Parser now supports full Prolog infix syntax via precedence climbing
- Seeded PRNG in simple-sat for reproducible results
- All JSON extraction uses balanced-brace parser instead of greedy regex
