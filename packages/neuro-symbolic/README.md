# @cogitator-ai/neuro-symbolic

Neuro-symbolic AI package for hybrid neural-symbolic reasoning. Combines LLM-based understanding with formal methods for verifiable, explainable AI.

## Installation

```bash
pnpm add @cogitator-ai/neuro-symbolic
```

For Z3 constraint solving support:

```bash
pnpm add z3-solver
```

## Features

- **Logic Programming** - Prolog-style rules with unification and SLD resolution
- **Knowledge Graph Queries** - SPARQL-like query language with natural language interface
- **Constraint Solving** - SAT/SMT solving with Z3 WASM or pure-TS fallback
- **Plan Verification** - PDDL-like action schemas with invariant checking and repair

---

## Quick Start

```typescript
import {
  createNeuroSymbolic,
  ConstraintBuilder,
  variable,
  constant,
} from '@cogitator-ai/neuro-symbolic';

const ns = createNeuroSymbolic();

// Logic Programming
ns.loadLogicProgram(`
  parent(tom, mary).
  parent(mary, ann).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
`);

const result = ns.queryLogic('grandparent(tom, X)?');
console.log(result.solutions); // X = ann

// Constraint Solving
const problem = ConstraintBuilder.create()
  .int('x', 1, 10)
  .int('y', 1, 10)
  .assert(variable('x').add(variable('y')).eq(constant(15)))
  .build();

const solution = await ns.solve(problem);
console.log(solution); // { x: 5, y: 10 } or similar
```

---

## Logic Programming

Prolog-style logic programming with backward chaining and unification.

### Loading Programs

```typescript
import { createNeuroSymbolic } from '@cogitator-ai/neuro-symbolic';

const ns = createNeuroSymbolic();

// Load facts and rules
ns.loadLogicProgram(`
  % Facts
  human(socrates).
  human(plato).

  % Rules
  mortal(X) :- human(X).

  % Lists
  append([], L, L).
  append([H|T], L, [H|R]) :- append(T, L, R).
`);
```

### Querying

```typescript
// Simple query
const result = ns.queryLogic('mortal(socrates)?');
console.log(result.success); // true

// Query with variables
const result = ns.queryLogic('mortal(X)?');
for (const solution of result.solutions) {
  console.log(solution.get('X')); // socrates, plato
}

// Multiple solutions
const result = ns.queryLogic('append(X, Y, [1,2,3])?');
// X=[], Y=[1,2,3]
// X=[1], Y=[2,3]
// X=[1,2], Y=[3]
// X=[1,2,3], Y=[]
```

### Proof Trees

```typescript
import { formatProofTree, proofTreeToMermaid } from '@cogitator-ai/neuro-symbolic';

const result = ns.queryLogic('grandparent(tom, X)?');
console.log(formatProofTree(result.proofTree));
console.log(proofTreeToMermaid(result.proofTree)); // Mermaid diagram
```

### Built-in Predicates

| Predicate                    | Description           |
| ---------------------------- | --------------------- |
| `is/2`                       | Arithmetic evaluation |
| `=/2`                        | Unification           |
| `\+/1`                       | Negation as failure   |
| `>/2`, `</2`, `>=/2`, `=</2` | Comparisons           |
| `member/2`                   | List membership       |
| `append/3`                   | List concatenation    |
| `length/2`                   | List length           |
| `reverse/2`                  | List reversal         |
| `findall/3`                  | Collect all solutions |
| `!/0`                        | Cut                   |

---

## Knowledge Graph Queries

SPARQL-like query language with natural language interface.

### Query Builder

```typescript
import { GraphQueryBuilder, variable, executeQuery } from '@cogitator-ai/neuro-symbolic';

const query = new GraphQueryBuilder()
  .select()
  .pattern(variable('person'), 'worksAt', 'Google')
  .pattern(variable('person'), 'hasSkill', variable('skill'))
  .filter('skill', 'contains', 'Python')
  .orderBy('person', 'asc')
  .limit(10)
  .build();

const result = await executeQuery(query, { adapter: graphAdapter, agentId: 'agent-1' });
```

### Natural Language Queries

```typescript
const result = await ns.askGraph('Who works at Google and knows Python?');
console.log(result.naturalLanguageResponse);
```

### Reasoning Engine

```typescript
import { createReasoningEngine, findPath, multiHopQuery } from '@cogitator-ai/neuro-symbolic';

const engine = createReasoningEngine(graphAdapter);

// Find path between entities
const path = await findPath(graphAdapter, 'Alice', 'CompanyX', { maxHops: 3 });

// Multi-hop query
const results = await multiHopQuery(graphAdapter, 'Alice', ['worksAt', 'locatedIn'], {
  maxHops: 2,
});

// Inference
const inferred = await engine.infer({
  enableTransitivity: true,
  enableInverse: true,
  enableComposition: true,
});
```

---

## Constraint Solving

SAT/SMT solving with fluent DSL.

### Building Constraints

```typescript
import {
  ConstraintBuilder,
  variable,
  constant,
  and,
  or,
  not,
  allDifferent,
} from '@cogitator-ai/neuro-symbolic';

const problem = ConstraintBuilder.create()
  // Define variables
  .bool('a')
  .bool('b')
  .int('x', 0, 100)
  .int('y', 0, 100)
  .real('z', 0.0, 1.0)

  // Add constraints
  .assert(variable('a').or(variable('b')))
  .assert(variable('x').add(variable('y')).lte(constant(50)))
  .assert(variable('z').mul(constant(2)).gt(constant(0.5)))
  .assert(allDifferent(variable('x'), variable('y')))

  // Optimization objective
  .maximize(variable('x').add(variable('y')))

  .build();

const result = await solve(problem);
if (result.status === 'sat') {
  console.log(result.model.assignments);
}
```

### Solver Selection

```typescript
import { isZ3Available, createZ3Solver, createSimpleSATSolver } from '@cogitator-ai/neuro-symbolic';

// Check Z3 availability
if (await isZ3Available()) {
  const solver = await createZ3Solver();
  const result = await solver.solve(problem);
} else {
  // Fallback to pure-TS solver
  const solver = createSimpleSATSolver();
  const result = solver.solve(problem);
}
```

### Expression Types

```typescript
// Arithmetic
variable('x').add(variable('y'));
variable('x').sub(constant(5));
variable('x').mul(constant(2));
variable('x').div(constant(3));

// Boolean
variable('a').and(variable('b'));
variable('a').or(variable('b'));
not(variable('a'));
variable('a').implies(variable('b'));
variable('a').iff(variable('b'));

// Comparisons
variable('x').eq(constant(10));
variable('x').neq(variable('y'));
variable('x').gt(constant(0));
variable('x').gte(constant(0));
variable('x').lt(constant(100));
variable('x').lte(constant(100));

// Global constraints
allDifferent(variable('x'), variable('y'), variable('z'));
atMost(2, variable('a'), variable('b'), variable('c'));
atLeast(1, variable('a'), variable('b'), variable('c'));
exactly(1, variable('a'), variable('b'), variable('c'));
```

---

## Plan Verification

PDDL-like planning with verification and repair.

### Action Schemas

```typescript
import { ActionSchemaBuilder, ActionRegistry } from '@cogitator-ai/neuro-symbolic';

const moveAction = new ActionSchemaBuilder('move')
  .description('Move robot from one location to another')
  .parameter('from', 'string', true)
  .parameter('to', 'string', true)
  .precondition({ type: 'simple', variable: 'robotAt', value: '${from}' })
  .precondition({ type: 'comparison', variable: 'battery', operator: 'gt', value: 10 })
  .effect({ type: 'assign', variable: 'robotAt', value: '${to}' })
  .effect({ type: 'decrement', variable: 'battery', amount: 5 })
  .cost(5)
  .build();

const registry = new ActionRegistry();
registry.register(moveAction);
```

### Plan Validation

```typescript
import { validatePlan, formatValidationResult } from '@cogitator-ai/neuro-symbolic';

const plan = {
  id: 'plan-1',
  actions: [
    { id: 'a1', schemaName: 'move', parameters: { from: 'A', to: 'B' } },
    { id: 'a2', schemaName: 'move', parameters: { from: 'B', to: 'C' } },
  ],
  initialState: { id: 's0', variables: { robotAt: 'A', battery: 100 } },
  goalConditions: [{ type: 'simple', variable: 'robotAt', value: 'C' }],
};

const result = validatePlan(registry, plan);
console.log(formatValidationResult(result));
```

### Invariant Checking

```typescript
import { createInvariantChecker, formatInvariantResults } from '@cogitator-ai/neuro-symbolic';

const checker = createInvariantChecker(registry);

// Add safety properties
checker.addInvariant('battery-non-negative', {
  type: 'comparison',
  variable: 'battery',
  operator: 'gte',
  value: 0,
});

checker.addNever('collision', {
  type: 'and',
  conditions: [
    { type: 'simple', variable: 'robotAt', value: 'danger-zone' },
    { type: 'simple', variable: 'alarmActive', value: false },
  ],
});

checker.addEventually('goal-reached', {
  type: 'simple',
  variable: 'goalAchieved',
  value: true,
});

const results = checker.checkPlan(plan);
console.log(formatInvariantResults(results));
```

### Plan Repair

```typescript
import { createPlanRepairer, formatRepairResult } from '@cogitator-ai/neuro-symbolic';

const repairer = createPlanRepairer(registry, {
  maxInsertions: 3,
  maxRemovals: 2,
  maxIterations: 10,
});

const repairResult = repairer.repair(plan, validationResult);
if (repairResult.success) {
  console.log('Repaired plan:', repairResult.repairedPlan);
} else {
  console.log('Suggestions:', repairResult.suggestions);
}
```

---

## Main Orchestrator

The `NeuroSymbolic` class integrates all modules.

```typescript
import { createNeuroSymbolic } from '@cogitator-ai/neuro-symbolic';

const ns = createNeuroSymbolic({
  graphAdapter: myGraphAdapter, // Optional: for knowledge graph queries
  config: {
    knowledgeGraph: {
      enableNaturalLanguage: true,
      defaultQueryLimit: 100,
    },
    logic: {
      maxDepth: 50,
      maxSolutions: 10,
      timeout: 5000,
    },
    constraints: {
      timeout: 10000,
      solver: 'z3', // or 'simple-sat'
    },
    planning: {
      maxPlanLength: 100,
      enableRepair: true,
      verifyInvariants: true,
    },
  },
});

// Logic
ns.loadLogicProgram('...');
const logicResult = ns.queryLogic('...');

// Constraints
const solverResult = await ns.solve(problem);

// Knowledge Graph
const graphResult = await ns.queryGraph(query);
const nlResult = await ns.askGraph('natural language question');

// Planning
ns.registerAction(actionSchema);
const validationResult = await ns.validatePlan(plan);
const repairResult = await ns.repairPlan(plan, validationResult);
```

---

## Agent Tools

Expose neuro-symbolic capabilities as tools for AI agents.

```typescript
import { createNeuroSymbolicTools, MemoryGraphAdapter } from '@cogitator-ai/neuro-symbolic';
import { Agent, Cogitator } from '@cogitator-ai/core';

// Create tools (optionally with graph adapter for knowledge graph features)
const graphAdapter = new MemoryGraphAdapter();
const nsTools = createNeuroSymbolicTools({ graphAdapter });

// Pre-load some logic rules
nsTools.instance.loadLogicProgram(`
  parent(tom, mary).
  parent(mary, ann).
  grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
`);

// Use with an agent
const agent = new Agent({
  name: 'reasoning-agent',
  model: 'gpt-4o',
  tools: nsTools.all,
  instructions: `You have formal reasoning capabilities.
Use queryLogic for Prolog-style queries.
Use solveConstraints for SAT/SMT problems.
Use validatePlan to verify action sequences.`,
});

const cogitator = new Cogitator({ model: 'gpt-4o' });
const result = await cogitator.run(agent, {
  input: 'Who are the grandparents of ann?',
});
```

### Available Tools

| Tool               | Description                                             |
| ------------------ | ------------------------------------------------------- |
| `queryLogic`       | Execute Prolog-style queries against the knowledge base |
| `assertFact`       | Add a fact or rule to the knowledge base                |
| `loadProgram`      | Load a full Prolog program with multiple clauses        |
| `solveConstraints` | Solve SAT/SMT constraint problems                       |
| `validatePlan`     | Validate a plan against action schemas                  |
| `repairPlan`       | Attempt to repair an invalid plan                       |
| `registerAction`   | Register an action schema for planning                  |
| `findPath`\*       | Find shortest path between graph nodes                  |
| `queryGraph`\*     | Query knowledge graph nodes and edges                   |
| `addGraphNode`\*   | Add a node to the knowledge graph                       |
| `addGraphEdge`\*   | Add an edge between graph nodes                         |

\*Graph tools only available when `graphAdapter` is provided.

### Factory Options

```typescript
interface NeuroSymbolicToolsOptions {
  // Use existing NeuroSymbolic instance
  instance?: NeuroSymbolic;

  // Or provide config for new instance
  graphAdapter?: GraphAdapter;
  config?: NeuroSymbolicConfig;
  agentId?: string;
}
```

### Memory Graph Adapter

Built-in in-memory graph adapter for testing and simple use cases:

```typescript
import { MemoryGraphAdapter } from '@cogitator-ai/neuro-symbolic';

const adapter = new MemoryGraphAdapter();

// Use with tools
const tools = createNeuroSymbolicTools({ graphAdapter: adapter });

// Or use directly
await adapter.addNode({
  agentId: 'agent-1',
  name: 'Alice',
  type: 'person',
  properties: { age: 30 },
});
```

---

## Module Imports

Each module can be imported separately:

```typescript
// Logic Programming
import {
  KnowledgeBase,
  SLDResolver,
  parseQuery,
  formatSolutions,
} from '@cogitator-ai/neuro-symbolic/logic';

// Knowledge Graph
import {
  GraphQueryBuilder,
  executeQuery,
  ReasoningEngine,
} from '@cogitator-ai/neuro-symbolic/knowledge-graph';

// Constraints
import { ConstraintBuilder, solve, Z3WASMSolver } from '@cogitator-ai/neuro-symbolic/constraints';

// Planning
import {
  ActionSchemaBuilder,
  PlanValidator,
  InvariantChecker,
} from '@cogitator-ai/neuro-symbolic/planning';
```

---

## Type Reference

```typescript
import type {
  // Logic
  Term,
  Clause,
  Substitution,
  ProofTree,
  LogicQueryResult,

  // Knowledge Graph
  GraphQuery,
  GraphQueryResult,
  NaturalLanguageQueryResult,

  // Constraints
  ConstraintProblem,
  ConstraintVariable,
  SolverResult,

  // Planning
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
