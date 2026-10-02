# @cogitator-ai/neuro-symbolic

Neuro-symbolic AI package for hybrid neural-symbolic reasoning. Combines LLM-based understanding with formal methods for verifiable, explainable AI.

## Installation

```bash
pnpm add @cogitator-ai/neuro-symbolic
```

Z3 SMT support is an optional dependency. If it is not installed automatically, add it explicitly:

```bash
pnpm add z3-solver
```

Without Z3 the package falls back to the built-in solver (exact search for finite domains, local search otherwise).

## Features

- **Logic Programming** - Prolog engine with ISO operator precedence, cut, if-then-else, negation, `findall/3`, `between/3` and proof trees
- **Knowledge Graph Queries** - SPARQL-like query language, natural language questions, path finding and rule-based inference
- **Constraint Solving** - SAT/SMT solving with Z3 (WASM) or a pure-TS fallback, including optimisation and soft constraints
- **Plan Verification** - PDDL-like action schemas with validation, ordering-threat detection, invariant checking and automatic repair

---

## Quick Start

```typescript
import { createNeuroSymbolic } from '@cogitator-ai/neuro-symbolic';

const ns = createNeuroSymbolic();

ns.loadLogicProgram(`
  parent(tom, mary).
  parent(mary, ann).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
`);

const result = ns.queryLogic('grandparent(tom, X)?');
console.log(result.data?.solutions[0].get('X')); // { type: 'atom', value: 'ann' }
console.log(ns.getLogicSolutions('grandparent(tom, X)')); // "X = ann."

const builder = ns.createConstraintProblem('sum');
const x = builder.int('x', 1, 10);
const y = builder.int('y', 1, 10);
builder.assert(x.add(y).eq(15));
builder.maximize(x);

const solution = await ns.solve(builder.build());
if (solution.data?.status === 'sat') {
  console.log(solution.data.model.assignments); // { x: 10, y: 5 }
}
```

---

## Logic Programming

Prolog-style logic programming with SLD resolution, unification and standard operator syntax.

### Loading Programs

```typescript
ns.loadLogicProgram(`
  % Facts
  human(socrates).
  human(plato).

  % Rules
  mortal(X) :- human(X).

  % Arithmetic uses ISO precedence: * binds tighter than +
  total(Price, Qty, T) :- T is Price * Qty + 5.

  % Cut is local to the clause that executes it
  grade(S, a) :- S >= 90, !.
  grade(S, b) :- S >= 75, !.
  grade(_, c).

  % If-then-else commits to the condition
  label(S, L) :- ( S >= 50 -> L = pass ; L = fail ).
`);
```

`loadLogicProgram` returns `{ success, errors }`; syntax errors include the line and column.

### Querying

Queries may be written with or without a trailing `.`/`?` and an optional `?-` prefix.

```typescript
const result = ns.queryLogic('mortal(X)?');
for (const solution of result.data?.solutions ?? []) {
  console.log(solution.get('X')); // socrates, plato
}

ns.proveLogic('mortal(socrates)').data; // true
ns.getLogicSolutions('append(X, Y, [1, 2])');
// "X = [], Y = [1, 2] ;\nX = [1], Y = [2] ;\nX = [1, 2], Y = []."

ns.queryLogic('findall(X, human(X), L), length(L, N)', { maxSolutions: 1 });
```

Variables starting with `_` (including the anonymous `_`) are not reported in answers. When a query runs out of time or depth, `result.error` / `result.data.explanation` says so.

### Proof Trees

Enable `traceExecution` to capture the proof tree:

```typescript
import {
  createNeuroSymbolic,
  formatProofTree,
  proofTreeToMermaid,
} from '@cogitator-ai/neuro-symbolic';

const traced = createNeuroSymbolic({ config: { logic: { traceExecution: true } } });
traced.loadLogicProgram(
  'parent(tom, mary). parent(mary, ann). grandparent(X, Z) :- parent(X, Y), parent(Y, Z).'
);

const proof = traced.queryLogic('grandparent(tom, X)').data?.proofTree;
if (proof) {
  console.log(formatProofTree(proof));
  console.log(proofTreeToMermaid(proof));
}
```

### Built-in Predicates

| Category      | Predicates                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Control       | `,/2`, `;/2`, `->/2`, `!/0`, `\+/1`, `not/1`, `call/1..8`, `findall/3`, `forall/2`, `between/3`                                                |
| Unification   | `=/2`, `\=/2`, `==/2`, `\==/2`, `@</2`, `@>/2`, `@=</2`, `@>=/2`, `compare/3`                                                                  |
| Arithmetic    | `is/2`, `=:=/2`, `=\=/2`, `</2`, `>/2`, `=</2`, `>=/2`, `succ/2`, `plus/3`                                                                     |
| Type checks   | `atom/1`, `number/1`, `integer/1`, `float/1`, `atomic/1`, `compound/1`, `var/1`, `nonvar/1`, `is_list/1`, `ground/1`, `string/1`, `callable/1` |
| Lists         | `member/2`, `append/3`, `length/2`, `reverse/2`, `nth0/3`, `nth1/3`, `last/2`, `sort/2`, `msort/2`, `sum_list/2`, `max_list/2`, `min_list/2`   |
| Terms & atoms | `functor/3`, `arg/3`, `=../2`, `copy_term/2`, `atom_length/2`, `atom_concat/3`                                                                 |
| Logic         | `true/0`, `fail/0`, `false/0`                                                                                                                  |

Arithmetic follows ISO semantics (`-7 mod 3 =:= 2`, `-7 // 2 =:= -3`, `div`, bitwise `/\ \/ xor << >>`, `gcd`, `min`, `max`, `abs`, trigonometry, `pi`, `e`, ...). Undefined results such as `sqrt(-1)` fail instead of binding `NaN`. Use `getBuiltinList()` / `isControlConstruct()` to inspect support at runtime.

---

## Knowledge Graph Queries

SPARQL-like query language with natural language interface. Works with any `GraphAdapter` (in-memory, Postgres, Neo4j, or adapters from `@cogitator-ai/memory`).

### Query Builder

```typescript
import {
  GraphQueryBuilder,
  graphVariable as variable,
  executeQuery,
} from '@cogitator-ai/neuro-symbolic';

const query = GraphQueryBuilder.select()
  .where(variable('person'), 'works_at', variable('company'))
  .where(variable('company'), 'located_in', 'Berlin')
  .filter('person.name', 'startsWith', 'A')
  .orderBy('person.name', 'asc')
  .limit(10)
  .build();

const result = await executeQuery(query, {
  adapter: graphAdapter,
  agentId: 'agent-1',
  variables: new Map(),
});
```

- Patterns join on shared variables; bidirectional edges match in both directions.
- `?x a person` / `?x type person` matches node entity types.
- `describe` queries match edges in either direction around the subject.
- Filters can address nested properties: `person.properties.profile.level`.
- `count('*', 'total')` counts all bindings.

### Query Strings

```typescript
import { parseQueryString } from '@cogitator-ai/neuro-symbolic';

const parsed = parseQueryString(`
  SELECT ?p WHERE { ?p works_at ?c . ?c located_in Berlin }
  FILTER(?p.confidence >= 0.5)
  ORDER BY DESC(?p.name)
  LIMIT 5
`);
```

Supported filter operators: `= != > >= < <= contains startsWith endsWith regex in notIn`.

### Natural Language Queries

```typescript
const answer = await ns.askGraph('Who works at "Acme"?');
console.log(answer.data?.naturalLanguageResponse);
```

`NeuroSymbolic` honours `config.knowledgeGraph.enableNaturalLanguage` and applies `defaultQueryLimit` to queries without an explicit limit.

### Reasoning Engine

```typescript
import { createReasoningEngine } from '@cogitator-ai/neuro-symbolic';

const engine = createReasoningEngine(graphAdapter, 'agent-1', { maxHops: 3, minConfidence: 0.5 });

const path = await engine.findPath(aliceId, companyId);
const hops = await engine.multiHopQuery(aliceId, ['works_at', 'located_in']);
const inferred = await engine.infer(); // transitive, inverse and composed relations, de-duplicated
```

---

## Constraint Solving

SAT/SMT solving with a fluent DSL. Variable declarations return expressions; constraints are added to the builder.

### Building Constraints

```typescript
import { ConstraintBuilder, allDifferent, solve } from '@cogitator-ai/neuro-symbolic';

const builder = ConstraintBuilder.create('example');
const a = builder.bool('a');
const b = builder.bool('b');
const x = builder.int('x', 0, 100);
const y = builder.int('y', 0, 100);
const z = builder.real('z', 0, 1);

builder.assert(a.or(b));
builder.assert(x.add(y).lte(50));
builder.assert(z.mul(2).gt(0.5));
builder.assert(allDifferent(x, y));
builder.soft(x.eq(10), 2);
builder.maximize(x.add(y));

const result = await solve(builder.build());
if (result.status === 'sat') {
  console.log(result.model.assignments, result.model.objectiveValue);
}
```

Declaring the same variable twice or an empty domain (`min > max`) throws.

### Solver Selection

`solve(problem, { solver: 'z3' })` (the default) uses Z3 when `z3-solver` can be loaded and otherwise falls back to the built-in solver.

```typescript
import { isZ3Available, solveWithZ3, solveSAT } from '@cogitator-ai/neuro-symbolic';

const result = (await isZ3Available()) ? await solveWithZ3(problem) : solveSAT(problem);
```

- **Z3**: integers, reals, booleans and bit-vectors (unsigned semantics); mixed Int/Real expressions are coerced automatically; objectives and soft constraints use Z3's optimiser.
- **Built-in solver**: exhaustive search when every variable has a finite domain (≤ 2^20 assignments) — exact `sat`/`unsat`, optimal objective, minimal soft-constraint violations; local search for real or unbounded variables (may return `unknown`).

### Expression Types

```typescript
x.add(y);
x.sub(5);
x.mul(2);
x.div(3);
x.mod(7);
x.pow(2);
x.abs();
x.min(y);
x.max(y);
a.and(b);
a.or(b);
a.not();
a.implies(b);
a.iff(b);
x.eq(10);
x.neq(y);
x.gt(0);
x.gte(0);
x.lt(100);
x.lte(100);

ite(a, x, y);
sum(x, y, z);
allDifferent(x, y, z);
atMost(2, a, b, c);
atLeast(1, a, b, c);
exactly(1, a, b, c);
```

---

## Plan Verification

PDDL-like planning with verification and repair. Parameter references use the `?name` syntax.

### Action Schemas

```typescript
import { ActionSchemaBuilder, ActionRegistry } from '@cogitator-ai/neuro-symbolic';

const move = ActionSchemaBuilder.create('move')
  .describe('Move robot from one location to another')
  .param('from', 'string')
  .param('to', 'string')
  .preSimple('robotAt', '?from')
  .preCompare('battery', 'gt', 10)
  .assign('robotAt', '?to')
  .decrement('battery', 5)
  .setCost(5)
  .build();

const registry = new ActionRegistry();
registry.register(move);
```

Precondition equality is structural (arrays and objects compare by value). Conditional effects evaluate their condition against the state _before_ the action.

### Plan Validation

```typescript
import { createAction, validatePlan, formatValidationResult } from '@cogitator-ai/neuro-symbolic';

const plan = {
  id: 'plan-1',
  actions: [
    createAction('move', { from: 'A', to: 'B' }),
    createAction('move', { from: 'B', to: 'C' }),
  ],
  initialState: { id: 's0', variables: { robotAt: 'A', battery: 100 } },
  goalConditions: [{ type: 'simple' as const, variable: 'robotAt', value: 'C' }],
};

const result = validatePlan(plan, registry, { maxSteps: 50 });
console.log(formatValidationResult(result));
```

Validation reports precondition violations, missing/unknown parameters, unmet goals, redundant actions and ordering threats (an action deleting a variable a later action requires).

### Invariant Checking

```typescript
import { createInvariantChecker, formatInvariantResults } from '@cogitator-ai/neuro-symbolic';

const checker = createInvariantChecker(registry);
checker.addInvariant('battery-non-negative', {
  type: 'comparison',
  variable: 'battery',
  operator: 'gte',
  value: 0,
});
checker.addNever('danger', { type: 'simple', variable: 'robotAt', value: 'danger-zone' });
checker.addEventually('arrived', { type: 'simple', variable: 'robotAt', value: 'C' });

console.log(formatInvariantResults(checker.checkPlan(plan)));
```

The trajectory stops at the first action whose preconditions do not hold.

### Plan Repair

```typescript
import { createPlanRepairer, formatRepairResult } from '@cogitator-ai/neuro-symbolic';

const repairer = createPlanRepairer(registry, { maxInsertions: 3, maxRemovals: 2 });
const repair = repairer.repair(plan);

if (repair.success) {
  console.log('Repaired plan:', repair.repairedPlan);
} else {
  console.log(formatRepairResult(repair));
}
```

Insertion suggestions are verified by simulation (an action is only suggested if applying it establishes the failed condition); missing parameters are filled from defaults or the current state.

---

## Main Orchestrator

The `NeuroSymbolic` class integrates all modules. Every method returns a `NeuroSymbolicResult` (`{ success, data?, error?, duration }`) instead of throwing.

```typescript
import { createNeuroSymbolic } from '@cogitator-ai/neuro-symbolic';

const ns = createNeuroSymbolic({
  graphAdapter: myGraphAdapter,
  agentId: 'agent-1',
  config: {
    knowledgeGraph: { enableNaturalLanguage: true, defaultQueryLimit: 100 },
    logic: { maxDepth: 50, maxSolutions: 10, timeout: 5000 },
    constraints: { timeout: 10000, solver: 'z3' },
    planning: { maxPlanLength: 100, enableRepair: true, verifyInvariants: true },
  },
});

ns.loadLogicProgram('...');
ns.queryLogic('...');

await ns.solve(problem);

await ns.queryGraph(query);
await ns.askGraph('natural language question');
await ns.findPath(startNodeId, endNodeId);

ns.registerAction(actionSchema);
ns.validatePlan(plan);
ns.repairPlan(plan);
ns.checkInvariants(plan);
await ns.validateAndRepair(plan);
```

| Method              | `success` means                                                |
| ------------------- | -------------------------------------------------------------- |
| `queryLogic`        | the query has at least one solution                            |
| `validatePlan`      | validation ran (see `data.valid`)                              |
| `repairPlan`        | the plan was repaired (suggestions are in `data` either way)   |
| `checkInvariants`   | all safety properties hold                                     |
| `validateAndRepair` | the (repaired) plan is valid **and** all invariants hold on it |

---

## Agent Tools

Expose neuro-symbolic capabilities as tools for AI agents.

```typescript
import { createNeuroSymbolicTools, MemoryGraphAdapter } from '@cogitator-ai/neuro-symbolic';
import { Agent, Cogitator } from '@cogitator-ai/core';

const nsTools = createNeuroSymbolicTools({ graphAdapter: new MemoryGraphAdapter() });

nsTools.instance.loadLogicProgram(`
  parent(tom, mary).
  parent(mary, ann).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
`);

const agent = new Agent({
  name: 'reasoning-agent',
  model: 'openai/gpt-4o',
  tools: nsTools.all,
  instructions:
    'Use query_logic for Prolog queries, solve_constraints for SAT/SMT problems and validate_plan to verify action sequences.',
});

const cogitator = new Cogitator({ llm: { defaultModel: 'openai/gpt-4o' } });
const result = await cogitator.run(agent, { input: 'Who are the grandparents of ann?' });
```

### Available Tools

| Property           | Tool name            | Description                                    |
| ------------------ | -------------------- | ---------------------------------------------- |
| `queryLogic`       | `query_logic`        | Run a Prolog query against the knowledge base  |
| `assertFact`       | `assert_fact`        | Add facts or rules                             |
| `loadProgram`      | `load_logic_program` | Load a Prolog program (optionally clearing)    |
| `solveConstraints` | `solve_constraints`  | Solve SAT/SMT problems with optional objective |
| `validatePlan`     | `validate_plan`      | Validate a plan against action schemas         |
| `repairPlan`       | `repair_plan`        | Repair an invalid plan                         |
| `registerAction`   | `register_action`    | Register an action schema                      |
| `findPath`\*       | `find_graph_path`    | Shortest path between graph nodes              |
| `queryGraph`\*     | `query_graph`        | Query nodes (and optionally their edges)       |
| `addGraphNode`\*   | `add_graph_node`     | Add a node                                     |
| `addGraphEdge`\*   | `add_graph_edge`     | Add an edge                                    |

\*Graph tools are available when a `graphAdapter` is passed or the provided `instance` has one.

### Factory Options

```typescript
interface NeuroSymbolicToolsOptions {
  instance?: NeuroSymbolic;
  graphAdapter?: GraphAdapter;
  config?: Partial<NeuroSymbolicConfig>;
  agentId?: string;
}
```

When `agentId` is set, graph tools read and write that agent's graph; otherwise they use the calling agent's id from the tool context. `createGraphTools(adapter, { agentId })` can be used on its own.

### Graph Adapters

```typescript
import {
  MemoryGraphAdapter,
  createPostgresGraphAdapter,
  createNeo4jGraphAdapter,
} from '@cogitator-ai/neuro-symbolic';

const memory = new MemoryGraphAdapter();
await memory.addNode({
  agentId: 'agent-1',
  name: 'Alice',
  type: 'person',
  aliases: [],
  properties: { age: 30 },
  confidence: 1,
  source: 'user',
});

const postgres = createPostgresGraphAdapter({ connectionString: process.env.DATABASE_URL! });
await postgres.connect();

const neo4j = createNeo4jGraphAdapter({
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'secret',
});
await neo4j.connect();
```

All adapters scope traversal and shortest-path search to the requesting agent, treat bidirectional edges as traversable in both directions and reject merges into a node listed among its own sources.

---

## Module Imports

Each module can be imported separately:

```typescript
import {
  KnowledgeBase,
  SLDResolver,
  parseQuery,
  formatSolutions,
} from '@cogitator-ai/neuro-symbolic/logic';
import {
  GraphQueryBuilder,
  executeQuery,
  ReasoningEngine,
} from '@cogitator-ai/neuro-symbolic/knowledge-graph';
import { ConstraintBuilder, solve, Z3WASMSolver } from '@cogitator-ai/neuro-symbolic/constraints';
import {
  ActionSchemaBuilder,
  PlanValidator,
  InvariantChecker,
} from '@cogitator-ai/neuro-symbolic/planning';
import { createNeuroSymbolicTools } from '@cogitator-ai/neuro-symbolic/tools';
```

---

## Type Reference

```typescript
import type {
  Term,
  Clause,
  Substitution,
  ProofTree,
  LogicQueryResult,
  GraphQuery,
  GraphQueryResult,
  NaturalLanguageQueryResult,
  ConstraintProblem,
  ConstraintVariable,
  SolverResult,
  ActionSchema,
  Plan,
  PlanState,
  PlanValidationResult,
  SafetyProperty,
  InvariantCheckResult,
} from '@cogitator-ai/types';
```

---

## License

MIT
