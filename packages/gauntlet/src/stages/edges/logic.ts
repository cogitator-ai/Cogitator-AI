import { Agent } from '@cogitator-ai/core';
import {
  ConstraintBuilder,
  allDifferent,
  createNLToFactsPrompt,
  createNeuroSymbolic,
  createNeuroSymbolicTools,
  formatProofTree,
  isZ3Available,
  parseLLMFactsResponse,
  solve,
  termToString,
} from '@cogitator-ai/neuro-symbolic';
import type { StageDefinition } from '../../runner/types.js';

const NEURO_SYMBOLIC = '@cogitator-ai/neuro-symbolic';
const CORE = '@cogitator-ai/core';

const APPROVAL_RULES = `
approver(M, E) :- reports_to(E, M).
approver(M, E) :- reports_to(E, X), approver(M, X).
`;

const ORG_MEMO =
  'Org update: Erin now reports to Dave. Dave reports to Carol, and so does Frank. ' +
  'Carol reports to Bob, the managing director. Gina is a contractor and reports to nobody.';

const ORG_FACTS = `
reports_to(erin, dave).
reports_to(dave, carol).
reports_to(frank, carol).
reports_to(carol, bob).
`;

/** Every binding of `variable` across the solutions of a query, sorted. */
function bindings(
  ns: ReturnType<typeof createNeuroSymbolic>,
  query: string,
  variable: string
): string[] {
  const result = ns.queryLogic(query);
  const values = (result.data?.solutions ?? []).flatMap((solution) => {
    const term = solution.get(variable);
    return term ? [termToString(term)] : [];
  });
  return [...new Set(values)].sort();
}

/** Proves Prolog-style reasoning and SAT/SMT solving work, alone and fed by a model. */
const neuroSymbolic: StageDefinition = {
  id: 'neuro-symbolic',
  title: 'Neuro-symbolic reasoning',
  description:
    'Prolog rules derive conclusions with a proof tree, a constraint solver schedules a rota and proves a contradiction unsat, a model turns a memo into facts the engine reasons over, and an agent answers through the logic tools.',
  packages: [NEURO_SYMBOLIC, CORE],
  needs: ['handshake'],
  timeoutMs: 150_000,
  async run(ctx) {
    await ctx.check('rules derive conclusions with a proof tree', (evidence) => {
      const ns = createNeuroSymbolic({ config: { logic: { traceExecution: true } } });
      const loaded = ns.loadLogicProgram(`${ORG_FACTS}${APPROVAL_RULES}
        chain_length(E, N) :- findall(M, approver(M, E), Ms), length(Ms, N).
        level(E, senior) :- chain_length(E, N), N =< 1, !.
        level(_, staff).
      `);
      if (!loaded.success) throw new Error(`Program did not load: ${loaded.errors.join('; ')}`);
      const approvers = bindings(ns, 'approver(X, erin)', 'X');
      const chain = bindings(ns, 'chain_length(erin, N)', 'N');
      const level = bindings(ns, 'level(carol, L)', 'L');
      const proof = ns.queryLogic('approver(bob, erin)').data?.proofTree;
      evidence('approversOfErin', approvers);
      evidence('chainLength', chain);
      evidence('carolLevel', level);
      evidence(
        'proof',
        proof
          ? formatProofTree(proof)
              .split('\n')
              .filter((line) => /approver|reports_to/.test(line))
              .slice(0, 4)
          : null
      );
      if (approvers.join() !== 'bob,carol,dave') {
        throw new Error(`Wrong approvers: ${approvers.join()}`);
      }
      if (chain.join() !== '3') throw new Error(`findall/length gave ${chain.join()}`);
      if (level.join() !== 'senior') throw new Error(`Cut did not commit: ${level.join()}`);
      if (!proof) throw new Error('traceExecution produced no proof tree');
      if (ns.proveLogic('approver(gina, erin)').data !== false) {
        throw new Error('An unfounded goal was proved');
      }
    });

    await ctx.check(
      'a constraint solver schedules a rota and proves a contradiction unsat',
      async (evidence) => {
        const builder = ConstraintBuilder.create('on-call rota');
        const alice = builder.int('alice', 1, 3);
        const bob = builder.int('bob', 1, 3);
        const carol = builder.int('carol', 1, 3);
        builder.assert(allDifferent(alice, bob, carol));
        builder.assert(alice.neq(1));
        builder.assert(bob.lt(carol));
        builder.minimize(carol.sub(bob));
        const rota = await solve(builder.build());
        evidence('z3', await isZ3Available());
        evidence('rota', rota.status === 'sat' ? rota.model.assignments : rota.status);
        if (rota.status !== 'sat') {
          throw new Error(`The rota is satisfiable, the solver said ${rota.status}`);
        }
        const { alice: a, bob: b, carol: c } = rota.model.assignments;
        if (new Set([a, b, c]).size !== 3 || a === 1 || Number(b) >= Number(c)) {
          throw new Error(
            `The model breaks the constraints: ${JSON.stringify(rota.model.assignments)}`
          );
        }

        const impossible = ConstraintBuilder.create('double booking');
        const slot = impossible.int('slot', 1, 5);
        impossible.assert(slot.gt(3));
        impossible.assert(slot.lt(3));
        const contradiction = await solve(impossible.build());
        evidence('contradiction', contradiction.status);
        if (contradiction.status !== 'unsat') {
          throw new Error(`Expected unsat, got ${contradiction.status}`);
        }
      }
    );

    await ctx.check(
      'the model extracts facts and the engine derives the chain',
      async (evidence) => {
        const prompt = createNLToFactsPrompt({
          naturalLanguageText: ORG_MEMO,
          existingPredicates: ['reports_to(Employee, Manager)'],
          domain: 'company reporting lines, lowercase first names as atoms',
        });
        const extractor = new Agent({
          name: 'fact-extractor',
          model: ctx.model,
          instructions: 'You output Prolog facts only, one per line, with no commentary.',
          maxIterations: 1,
          temperature: 0,
        });
        const run = await ctx.cogitator.run(extractor, { input: prompt });
        const parsed = parseLLMFactsResponse(run.output);
        evidence('facts', parsed.facts);
        if (!parsed.success || !parsed.facts) throw new Error(parsed.error ?? 'No facts parsed');

        const ns = createNeuroSymbolic();
        const loaded = ns.loadLogicProgram(`${parsed.facts.join('\n')}\n${APPROVAL_RULES}`);
        if (!loaded.success) {
          throw new Error(`Extracted facts did not load: ${loaded.errors.join('; ')}`);
        }
        const erin = bindings(ns, 'approver(X, erin)', 'X');
        const frank = bindings(ns, 'approver(X, frank)', 'X');
        evidence('approversOfErin', erin);
        evidence('approversOfFrank', frank);
        if (erin.join() !== 'bob,carol,dave') {
          throw new Error(`Derived approvers of erin: ${erin.join()}`);
        }
        if (frank.join() !== 'bob,carol') {
          throw new Error(`Derived approvers of frank: ${frank.join()}`);
        }
      }
    );

    await ctx.check('an agent answers through the logic tools', async (evidence) => {
      const tools = createNeuroSymbolicTools();
      const loaded = tools.instance.loadLogicProgram(`${ORG_FACTS}${APPROVAL_RULES}`);
      if (!loaded.success) throw new Error(loaded.errors.join('; '));
      const agent = new Agent({
        name: 'policy-reasoner',
        model: ctx.models[1] ?? ctx.model,
        instructions:
          'You answer policy questions only from the logic knowledge base. It defines approver(Manager, Employee). ' +
          'Always run query_logic before answering and list every name the query returns.',
        tools: tools.all,
        maxIterations: 5,
        temperature: 0,
      });
      const run = await ctx.cogitator.run(agent, {
        input: 'Who can approve expenses filed by frank?',
      });
      const queries = run.toolCalls.filter((call) => call.name === 'query_logic');
      evidence(
        'queries',
        queries.map((call) => call.arguments)
      );
      evidence('answer', run.output.slice(0, 200));
      if (queries.length === 0) throw new Error('The agent answered without query_logic');
      const answer = run.output.toLowerCase();
      if (!answer.includes('carol') || !answer.includes('bob')) {
        throw new Error('The answer misses an approver the knowledge base derives');
      }
    });
  },
};

export const logicStages: StageDefinition[] = [neuroSymbolic];
