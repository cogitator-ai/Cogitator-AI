# @cogitator-ai/neuro-symbolic

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
