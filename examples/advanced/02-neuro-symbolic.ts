import { header, section } from '../_shared/setup.js';
import {
  createKnowledgeBase,
  queryKnowledgeBase,
  formatSolutions,
  ConstraintBuilder,
  allDifferent,
  solveSAT,
  problemToString,
  ActionSchemaBuilder,
  ActionRegistry,
  createAction,
  simulatePlan,
  validatePlan,
  formatValidationResult,
  actionToString,
  createNeuroSymbolic,
  isZ3Available,
  MemoryGraphAdapter,
  parseQueryString,
} from '@cogitator-ai/neuro-symbolic';
import type { Plan, PlanState, GraphNode, RelationType } from '@cogitator-ai/types';
import { randomUUID } from 'node:crypto';

async function main() {
  header('02 — Neuro-Symbolic Reasoning');

  section('1. Logic programming — family relationships');

  const kb = createKnowledgeBase();

  const consultResult = kb.consult(`
    parent(tom, bob).
    parent(tom, liz).
    parent(bob, ann).
    parent(bob, pat).
    parent(pat, jim).
    parent(pat, kim).

    male(tom).
    male(bob).
    male(jim).
    female(liz).
    female(ann).
    female(pat).
    female(kim).

    father(X, Y) :- parent(X, Y), male(X).
    mother(X, Y) :- parent(X, Y), female(X).
    grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
    ancestor(X, Y) :- parent(X, Y).
    ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
  `);

  if (!consultResult.success) {
    console.log('  Parse errors:', consultResult.errors);
  }

  const stats = kb.getStats();
  console.log(`  Knowledge base: ${stats.factCount} facts, ${stats.ruleCount} rules`);
  console.log(`  Predicates: ${stats.predicates.join(', ')}`);

  const queries = [
    { label: "Who is Bob's father?", query: 'father(X, bob)' },
    { label: "Who are Tom's grandchildren?", query: 'grandparent(tom, X)' },
    { label: "Who are Bob's children?", query: 'parent(bob, X)' },
    { label: "Who are Tom's descendants?", query: 'ancestor(tom, X)' },
  ];

  for (const { label, query } of queries) {
    const result = queryKnowledgeBase(kb, query);
    console.log(`\n  Q: ${label}`);
    console.log(`     ${query} => ${formatSolutions(result)}`);
    console.log(`     Solutions: ${result.solutions.length}`);
  }

  section('2. Dynamic knowledge — adding facts at runtime');

  kb.assert('parent(jim, sam).');
  kb.assert('male(sam).');

  const newQuery = queryKnowledgeBase(kb, 'ancestor(tom, sam)');
  console.log(`  Added: parent(jim, sam), male(sam)`);
  console.log(`  Is Tom an ancestor of Sam? ${newQuery.success ? 'yes' : 'no'}`);

  const samGrandparent = queryKnowledgeBase(kb, 'grandparent(X, sam)');
  console.log(`  Sam's grandparent: ${formatSolutions(samGrandparent)}`);

  section('3. Constraint solving — conference room scheduling');

  const builder = ConstraintBuilder.create('conference-scheduling');

  const teamA = builder.int('team_a_slot', 0, 3);
  const teamB = builder.int('team_b_slot', 0, 3);
  const teamC = builder.int('team_c_slot', 0, 3);
  const teamD = builder.int('team_d_slot', 0, 3);

  builder.assert(allDifferent(teamA, teamB, teamC, teamD), 'no overlapping slots');
  builder.assert(teamA.lt(teamB), 'team A before team B (dependency)');
  builder.assert(teamC.neq(0), 'team C not in morning slot');
  builder.assert(teamD.gt(teamA), 'team D after team A');

  const problem = builder.build();

  console.log(problemToString(problem));
  console.log();

  const solverResult = solveSAT(problem, { timeout: 5000, maxIterations: 5000 });

  const slotNames = ['9:00-10:00', '10:00-11:00', '11:00-12:00', '1:00-2:00'];
  const teams = ['team_a_slot', 'team_b_slot', 'team_c_slot', 'team_d_slot'];
  const teamLabels: Record<string, string> = {
    team_a_slot: 'Engineering',
    team_b_slot: 'Product',
    team_c_slot: 'Design',
    team_d_slot: 'Marketing',
  };

  if (solverResult.status === 'sat' && solverResult.model) {
    console.log('  Schedule found:');
    const schedule = teams
      .map((t) => ({
        team: teamLabels[t],
        slot: solverResult.model!.assignments[t] as number,
      }))
      .sort((a, b) => a.slot - b.slot);

    for (const { team, slot } of schedule) {
      console.log(`    ${slotNames[slot]}  ${team}`);
    }
  } else {
    console.log(`  Solver result: ${solverResult.status}`);
  }

  section('4. Boolean satisfiability — task assignment');

  const satBuilder = ConstraintBuilder.create('task-assignment');

  const alice_task1 = satBuilder.bool('alice_task1');
  const alice_task2 = satBuilder.bool('alice_task2');
  const bob_task1 = satBuilder.bool('bob_task1');
  const bob_task2 = satBuilder.bool('bob_task2');
  const carol_task1 = satBuilder.bool('carol_task1');
  const carol_task2 = satBuilder.bool('carol_task2');

  satBuilder.assert(alice_task1.or(bob_task1).or(carol_task1), 'task 1 assigned to someone');
  satBuilder.assert(alice_task2.or(bob_task2).or(carol_task2), 'task 2 assigned to someone');

  satBuilder.assert(alice_task1.and(alice_task2).not(), 'alice gets at most one task');
  satBuilder.assert(bob_task1.and(bob_task2).not(), 'bob gets at most one task');

  satBuilder.assert(carol_task2.not(), 'carol cannot do task 2');

  const satProblem = satBuilder.build();
  const satResult = solveSAT(satProblem);

  if (satResult.status === 'sat' && satResult.model) {
    console.log('  Task assignment:');
    const assignments = satResult.model.assignments;
    const taskAssignees: Record<string, string[]> = { task1: [], task2: [] };

    for (const [key, val] of Object.entries(assignments)) {
      if (val === true) {
        const [person, task] = key.split('_');
        taskAssignees[task]?.push(person);
      }
    }

    for (const [task, people] of Object.entries(taskAssignees)) {
      if (people.length > 0) {
        console.log(`    ${task}: ${people.join(', ')}`);
      }
    }
  } else {
    console.log(`  SAT result: ${satResult.status}`);
  }

  section('5. Planning — logistics with formal verification');

  const registry = new ActionRegistry();

  registry.register(
    ActionSchemaBuilder.create('load_package_a')
      .describe('Load package A onto the truck at warehouse')
      .preSimple('pkg_a', 'warehouse')
      .preSimple('truck', 'warehouse')
      .assign('pkg_a', 'on_truck')
      .setCost(1)
      .build()
  );

  registry.register(
    ActionSchemaBuilder.create('load_package_b')
      .describe('Load package B onto the truck at warehouse')
      .preSimple('pkg_b', 'warehouse')
      .preSimple('truck', 'warehouse')
      .assign('pkg_b', 'on_truck')
      .setCost(1)
      .build()
  );

  registry.register(
    ActionSchemaBuilder.create('drive_to_office')
      .describe('Drive the truck from warehouse to office')
      .preSimple('truck', 'warehouse')
      .assign('truck', 'office')
      .setCost(3)
      .build()
  );

  registry.register(
    ActionSchemaBuilder.create('unload_package_a')
      .describe('Unload package A from the truck at office')
      .preSimple('pkg_a', 'on_truck')
      .preSimple('truck', 'office')
      .assign('pkg_a', 'office')
      .setCost(1)
      .build()
  );

  registry.register(
    ActionSchemaBuilder.create('drive_to_store')
      .describe('Drive the truck from office to store')
      .preSimple('truck', 'office')
      .assign('truck', 'store')
      .setCost(3)
      .build()
  );

  registry.register(
    ActionSchemaBuilder.create('unload_package_b')
      .describe('Unload package B from the truck at store')
      .preSimple('pkg_b', 'on_truck')
      .preSimple('truck', 'store')
      .assign('pkg_b', 'store')
      .setCost(1)
      .build()
  );

  console.log('  Registered actions:');
  for (const schema of registry.getAll()) {
    console.log(`    - ${schema.name}: ${schema.description}`);
    console.log(`      Cost: ${schema.cost}, Preconditions: ${schema.preconditions.length}`);
  }

  const initialState: PlanState = {
    id: randomUUID().slice(0, 8),
    variables: {
      pkg_a: 'warehouse',
      pkg_b: 'warehouse',
      truck: 'warehouse',
    },
  };

  const plan: Plan = {
    id: randomUUID().slice(0, 8),
    name: 'deliver-packages',
    initialState,
    actions: [
      createAction('load_package_a', {}),
      createAction('load_package_b', {}),
      createAction('drive_to_office', {}),
      createAction('unload_package_a', {}),
      createAction('drive_to_store', {}),
      createAction('unload_package_b', {}),
    ],
    goalConditions: [
      { type: 'simple', variable: 'pkg_a', value: 'office' },
      { type: 'simple', variable: 'pkg_b', value: 'store' },
    ],
  };

  console.log('\n  Plan actions:');
  for (let i = 0; i < plan.actions.length; i++) {
    console.log(`    ${i + 1}. ${actionToString(plan.actions[i])}`);
  }

  const validation = validatePlan(plan, registry);
  console.log(`\n${formatValidationResult(validation)}`);

  const simulation = simulatePlan(plan, registry);
  console.log(`\n  Simulation success: ${simulation.success}`);
  console.log(`  Final state:`);
  for (const [key, val] of Object.entries(simulation.finalState.variables)) {
    console.log(`    ${key}: ${val}`);
  }

  const totalCost = plan.actions.reduce((sum, action) => {
    const schema = registry.get(action.schemaName);
    return sum + (schema?.cost ?? 0);
  }, 0);
  console.log(`  Total plan cost: ${totalCost}`);

  section('6. Rules with arithmetic, cut and aggregation');

  const pricing = createKnowledgeBase(`
    price(laptop, 1200).
    price(mouse, 25).
    price(monitor, 300).
    discount(Total, D) :- ( Total >= 1000 -> D is Total * 0.1 ; D = 0 ).
    tier(P, premium) :- P >= 1000, !.
    tier(P, standard) :- P >= 100, !.
    tier(_, budget).
  `);

  console.log(
    `  Cart total: ${formatSolutions(queryKnowledgeBase(pricing, 'findall(P, price(_, P), Ps), sum_list(Ps, Total), discount(Total, D)'))}`
  );
  console.log(
    `  Tiers: ${formatSolutions(queryKnowledgeBase(pricing, 'price(Item, P), tier(P, Tier)'))}`
  );

  section('7. Optimisation with Z3 (falls back to the built-in solver)');

  const ns = createNeuroSymbolic();
  const staffing = ns.createConstraintProblem('staffing');
  const seniors = staffing.int('seniors', 0, 10);
  const juniors = staffing.int('juniors', 0, 10);
  staffing.assert(seniors.add(juniors).gte(8), 'cover 8 shifts');
  staffing.assert(seniors.mul(2).gte(juniors), 'one senior per two juniors');
  staffing.minimize(seniors.mul(300).add(juniors.mul(180)));

  const staffingResult = await ns.solve(staffing.build());
  console.log(`  Solver backend: ${(await isZ3Available()) ? 'Z3' : 'simple-sat'}`);
  if (staffingResult.data?.status === 'sat') {
    const { assignments, objectiveValue } = staffingResult.data.model;
    console.log(
      `  Hire ${assignments.seniors} seniors and ${assignments.juniors} juniors (cost ${objectiveValue})`
    );
  } else {
    console.log(`  Solver result: ${staffingResult.data?.status ?? staffingResult.error}`);
  }

  section('8. Knowledge graph queries');

  const graph = new MemoryGraphAdapter();
  const nodes: Record<string, GraphNode> = {};
  for (const [name, type] of [
    ['Alice', 'person'],
    ['Bob', 'person'],
    ['Acme', 'organization'],
    ['Berlin', 'location'],
  ] as const) {
    const node = await graph.addNode({
      agentId: 'demo',
      name,
      type,
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user',
    });
    if (node.success) nodes[name] = node.data;
  }
  const relate = (from: string, to: string, type: RelationType) =>
    graph.addEdge({
      agentId: 'demo',
      sourceNodeId: nodes[from].id,
      targetNodeId: nodes[to].id,
      type,
      weight: 1,
      bidirectional: false,
      properties: {},
      confidence: 1,
      source: 'user',
    });
  await relate('Alice', 'Acme', 'works_at');
  await relate('Bob', 'Acme', 'works_at');
  await relate('Acme', 'Berlin', 'located_in');

  const graphNs = createNeuroSymbolic({ graphAdapter: graph, agentId: 'demo' });
  const berliners = await graphNs.queryGraph(
    parseQueryString('SELECT ?p WHERE { ?p works_at ?c . ?c located_in Berlin } ORDER BY ?p.name')
  );
  console.log(
    `  Works in Berlin: ${berliners.data?.bindings.map((b) => (b.p as GraphNode).name).join(', ')}`
  );

  const answer = await graphNs.askGraph('Tell me about Acme');
  console.log(
    `  "Tell me about Acme":\n    ${answer.data?.naturalLanguageResponse.replace(/\n/g, '\n    ')}`
  );

  console.log('\nDone.');
}

main();
