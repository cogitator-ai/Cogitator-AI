import type {
  Term,
  CompoundTerm,
  Clause,
  Substitution,
  ProofNode,
  ProofTree,
  LogicQueryResult,
  LogicProgrammingConfig,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { KnowledgeBase } from './knowledge-base';
import {
  unify,
  applySubstitution,
  renameVariables,
  getVariables,
  termToString,
} from './unification';
import { isBuiltin, executeBuiltin } from './builtins';
import { parseQuery } from './parser';

interface Goal {
  term: CompoundTerm;
  barrier: number;
}

interface Outcome {
  success: boolean;
  cutTo?: number;
  stop?: boolean;
}

type SolutionHandler = (substitution: Substitution) => boolean;

interface ResolverContext {
  kb: KnowledgeBase;
  config: Required<LogicProgrammingConfig>;
  startTime: number;
  exploredNodes: number;
  maxDepthReached: number;
  depthLimitHit: boolean;
  timedOut: boolean;
  clauseCounter: number;
  barrierCounter: number;
  onSolution: SolutionHandler;
}

const ROOT_BARRIER = 0;
const MAX_FINDALL_RESULTS = 100_000;

function createProofNode(goal: CompoundTerm, subst: Substitution, depth: number): ProofNode {
  return {
    id: nanoid(8),
    goal,
    substitution: subst,
    children: [],
    status: 'pending',
    depth,
  };
}

function getDefaultConfig(): Required<LogicProgrammingConfig> {
  return {
    maxDepth: 50,
    maxSolutions: 10,
    timeout: 5000,
    enableCut: true,
    enableNegation: true,
    traceExecution: false,
  };
}

function toCallable(term: Term): CompoundTerm | null {
  if (term.type === 'compound') return term;
  if (term.type === 'atom') return { type: 'compound', functor: term.value, args: [] };
  return null;
}

function addArguments(goal: Term, extra: Term[]): CompoundTerm | null {
  const callable = toCallable(goal);
  if (!callable) return null;
  if (extra.length === 0) return callable;
  return { type: 'compound', functor: callable.functor, args: [...callable.args, ...extra] };
}

function mergeCut(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function asGoals(terms: CompoundTerm[], barrier: number): Goal[] {
  return terms.map((term) => ({ term, barrier }));
}

function child(
  parent: ProofNode,
  goal: CompoundTerm,
  subst: Substitution,
  depth: number
): ProofNode {
  const node = createProofNode(goal, subst, depth);
  parent.children.push(node);
  return node;
}

function finish(node: ProofNode, outcome: Outcome): Outcome {
  if (node.status !== 'cut') {
    node.status = outcome.success ? 'success' : 'failure';
  }
  return outcome;
}

function solveWith(
  goals: CompoundTerm[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext,
  handler: SolutionHandler
): void {
  const barrier = ++ctx.barrierCounter;
  const saved = ctx.onSolution;
  ctx.onSolution = handler;
  try {
    resolve(asGoals(goals, barrier), subst, depth, node, ctx);
  } finally {
    ctx.onSolution = saved;
  }
}

function solveOnce(
  goals: CompoundTerm[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Substitution | null {
  let found: Substitution | null = null;
  solveWith(goals, subst, depth, node, ctx, (solution) => {
    found = solution;
    return true;
  });
  return found;
}

function resolve(
  goals: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  ctx.exploredNodes++;
  if (depth > ctx.maxDepthReached) ctx.maxDepthReached = depth;

  if (ctx.timedOut || Date.now() - ctx.startTime > ctx.config.timeout) {
    ctx.timedOut = true;
    node.status = 'failure';
    return { success: false, stop: true };
  }

  if (depth > ctx.config.maxDepth) {
    ctx.depthLimitHit = true;
    node.status = 'failure';
    return { success: false };
  }

  if (goals.length === 0) {
    node.status = 'success';
    return { success: true, stop: ctx.onSolution(subst) };
  }

  const [goal, ...rest] = goals;
  const term = applySubstitution(goal.term, subst) as CompoundTerm;
  const key = `${term.functor}/${term.args.length}`;

  switch (key) {
    case '!/0':
      return resolveCut(goal, rest, subst, depth, node, ctx);
    case ',/2':
      return resolveConjunction(term, goal, rest, subst, depth, node, ctx);
    case ';/2':
      return resolveDisjunction(term, goal, rest, subst, depth, node, ctx);
    case '->/2':
      return resolveIfThenElse(
        term.args[0],
        term.args[1],
        null,
        goal,
        rest,
        subst,
        depth,
        node,
        ctx
      );
    case '\\+/1':
    case 'not/1':
      if (!ctx.config.enableNegation) break;
      return resolveNegation(term, rest, subst, depth, node, ctx);
    case 'findall/3':
      return resolveFindall(term, rest, subst, depth, node, ctx);
    case 'forall/2':
      return resolveForall(term, rest, subst, depth, node, ctx);
    case 'between/3':
      return resolveBetween(term, rest, subst, depth, node, ctx);
  }

  if (term.functor === 'call' && term.args.length >= 1) {
    return resolveCall(term, rest, subst, depth, node, ctx);
  }

  if (isBuiltin(term.functor, term.args.length)) {
    return resolveBuiltin(term, rest, subst, depth, node, ctx);
  }

  return resolveUserPredicate(term, rest, subst, depth, node, ctx);
}

function resolveCut(
  goal: Goal,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const cutNode = child(node, goal.term, subst, depth + 1);
  cutNode.status = 'cut';
  const outcome = resolve(rest, subst, depth + 1, cutNode, ctx);
  if (!ctx.config.enableCut) return outcome;
  return { ...outcome, cutTo: mergeCut(outcome.cutTo, goal.barrier) };
}

function resolveConjunction(
  term: CompoundTerm,
  goal: Goal,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const first = toCallable(term.args[0]);
  const second = toCallable(term.args[1]);
  if (!first || !second) return finish(node, { success: false });

  return resolve(
    [{ term: first, barrier: goal.barrier }, { term: second, barrier: goal.barrier }, ...rest],
    subst,
    depth,
    node,
    ctx
  );
}

function resolveDisjunction(
  term: CompoundTerm,
  goal: Goal,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const [left, right] = term.args;

  if (left.type === 'compound' && left.functor === '->' && left.args.length === 2) {
    return resolveIfThenElse(
      left.args[0],
      left.args[1],
      right,
      goal,
      rest,
      subst,
      depth,
      node,
      ctx
    );
  }

  const leftGoal = toCallable(left);
  const rightGoal = toCallable(right);
  let success = false;

  if (leftGoal) {
    const leftNode = child(node, leftGoal, subst, depth + 1);
    const outcome = finish(
      leftNode,
      resolve([{ term: leftGoal, barrier: goal.barrier }, ...rest], subst, depth + 1, leftNode, ctx)
    );
    success = outcome.success;
    if (outcome.stop || outcome.cutTo !== undefined) return finish(node, outcome);
  }

  if (rightGoal) {
    const rightNode = child(node, rightGoal, subst, depth + 1);
    const outcome = finish(
      rightNode,
      resolve(
        [{ term: rightGoal, barrier: goal.barrier }, ...rest],
        subst,
        depth + 1,
        rightNode,
        ctx
      )
    );
    return finish(node, { ...outcome, success: success || outcome.success });
  }

  return finish(node, { success });
}

function resolveIfThenElse(
  condition: Term,
  thenBranch: Term,
  elseBranch: Term | null,
  goal: Goal,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const condGoal = toCallable(condition);
  if (!condGoal) return finish(node, { success: false });

  const condNode = child(node, condGoal, subst, depth + 1);
  const condSubst = solveOnce([condGoal], subst, depth + 1, condNode, ctx);
  condNode.status = condSubst ? 'success' : 'failure';
  if (ctx.timedOut) return finish(node, { success: false, stop: true });

  const branch = condSubst ? thenBranch : elseBranch;
  if (branch === null) return finish(node, { success: false });

  const branchGoal = toCallable(branch);
  if (!branchGoal) return finish(node, { success: false });

  return finish(
    node,
    resolve(
      [{ term: branchGoal, barrier: goal.barrier }, ...rest],
      condSubst ?? subst,
      depth + 1,
      condNode,
      ctx
    )
  );
}

function resolveNegation(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const negated = toCallable(term.args[0]);
  if (!negated) return finish(node, { success: false });

  const negNode = child(node, term, subst, depth + 1);
  const testNode = child(negNode, negated, subst, depth + 1);
  const proof = solveOnce([negated], subst, depth + 1, testNode, ctx);
  if (ctx.timedOut) return finish(node, { success: false, stop: true });

  if (proof) {
    negNode.status = 'failure';
    return finish(node, { success: false });
  }

  negNode.status = 'success';
  return finish(node, resolve(rest, subst, depth + 1, negNode, ctx));
}

function resolveCall(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const target = addArguments(term.args[0], term.args.slice(1));
  if (!target) return finish(node, { success: false });

  const barrier = ++ctx.barrierCounter;
  const callNode = child(node, target, subst, depth + 1);
  const outcome = finish(
    callNode,
    resolve([{ term: target, barrier }, ...rest], subst, depth + 1, callNode, ctx)
  );
  return finish(node, {
    success: outcome.success,
    stop: outcome.stop,
    cutTo: outcome.cutTo === barrier ? undefined : outcome.cutTo,
  });
}

function resolveFindall(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const [template, goalTerm, resultTerm] = term.args;
  const goal = toCallable(goalTerm);
  if (!goal) return finish(node, { success: false });

  const findNode = child(node, term, subst, depth + 1);
  const collected: Term[] = [];
  solveWith([goal], subst, depth + 1, findNode, ctx, (solution) => {
    collected.push(applySubstitution(template, solution));
    return collected.length >= MAX_FINDALL_RESULTS;
  });
  if (ctx.timedOut) return finish(node, { success: false, stop: true });

  const unified = unify(resultTerm, { type: 'list', elements: collected }, subst);
  findNode.status = unified ? 'success' : 'failure';
  if (!unified) return finish(node, { success: false });

  return finish(node, resolve(rest, unified, depth + 1, findNode, ctx));
}

function resolveForall(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const condition = toCallable(term.args[0]);
  const action = toCallable(term.args[1]);
  if (!condition || !action) return finish(node, { success: false });

  const forallNode = child(node, term, subst, depth + 1);
  let holds = true;
  solveWith([condition], subst, depth + 1, forallNode, ctx, (solution) => {
    if (!solveOnce([action], solution, depth + 1, forallNode, ctx)) {
      holds = false;
      return true;
    }
    return false;
  });
  if (ctx.timedOut) return finish(node, { success: false, stop: true });

  forallNode.status = holds ? 'success' : 'failure';
  if (!holds) return finish(node, { success: false });

  return finish(node, resolve(rest, subst, depth + 1, forallNode, ctx));
}

function resolveBetween(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const low = term.args[0];
  const high = term.args[1];
  const target = term.args[2];

  if (low.type !== 'number' || !Number.isInteger(low.value))
    return finish(node, { success: false });

  let upper: number;
  if (high.type === 'number' && Number.isInteger(high.value)) {
    upper = high.value;
  } else if (high.type === 'atom' && (high.value === 'inf' || high.value === 'infinite')) {
    upper = Infinity;
  } else {
    return finish(node, { success: false });
  }

  if (target.type === 'number') {
    const ok = Number.isInteger(target.value) && target.value >= low.value && target.value <= upper;
    if (!ok) return finish(node, { success: false });
    const betweenNode = child(node, term, subst, depth + 1);
    return finish(node, finish(betweenNode, resolve(rest, subst, depth + 1, betweenNode, ctx)));
  }

  if (target.type !== 'variable') return finish(node, { success: false });

  let success = false;
  for (let value = low.value; value <= upper; value++) {
    const bound = unify(target, { type: 'number', value }, subst);
    if (!bound) continue;

    const branchNode = child(node, term, bound, depth + 1);
    const outcome = finish(branchNode, resolve(rest, bound, depth + 1, branchNode, ctx));
    success ||= outcome.success;
    if (outcome.stop || outcome.cutTo !== undefined) {
      return finish(node, { ...outcome, success });
    }
  }

  return finish(node, { success });
}

function resolveBuiltin(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const builtinNode = child(node, term, subst, depth + 1);
  const result = executeBuiltin(term, subst);

  if (!result.success) {
    builtinNode.status = 'failure';
    return finish(node, { success: false });
  }

  let success = false;
  for (const newSubst of result.substitutions) {
    const branchNode = child(builtinNode, term, newSubst, depth + 1);
    const outcome = finish(branchNode, resolve(rest, newSubst, depth + 1, branchNode, ctx));
    success ||= outcome.success;
    if (outcome.stop || outcome.cutTo !== undefined) {
      builtinNode.status = success ? 'success' : 'failure';
      return finish(node, { ...outcome, success });
    }
  }

  builtinNode.status = success ? 'success' : 'failure';
  return finish(node, { success });
}

function resolveUserPredicate(
  term: CompoundTerm,
  rest: Goal[],
  subst: Substitution,
  depth: number,
  node: ProofNode,
  ctx: ResolverContext
): Outcome {
  const clauses = [...ctx.kb.getClauses(term.functor, term.args.length)];
  if (clauses.length === 0) return finish(node, { success: false });

  const barrier = ++ctx.barrierCounter;
  let success = false;

  for (const clause of clauses) {
    ctx.clauseCounter++;
    const renamed = renameClause(clause, `_${ctx.clauseCounter}`);
    const unified = unify(term, renamed.head, subst);
    if (unified === null) continue;

    const clauseNode = child(node, term, unified, depth + 1);
    clauseNode.clause = renamed;

    const outcome = finish(
      clauseNode,
      resolve([...asGoals(renamed.body, barrier), ...rest], unified, depth + 1, clauseNode, ctx)
    );
    success ||= outcome.success;

    if (outcome.stop) return finish(node, { success, stop: true });
    if (outcome.cutTo !== undefined) {
      if (outcome.cutTo === barrier) break;
      return finish(node, { success, cutTo: outcome.cutTo });
    }
  }

  return finish(node, { success });
}

function renameClause(clause: Clause, suffix: string): Clause {
  return {
    head: renameVariables(clause.head, suffix) as CompoundTerm,
    body: clause.body.map((g) => renameVariables(g, suffix) as CompoundTerm),
    metadata: clause.metadata,
  };
}

function isReportedVariable(name: string): boolean {
  return !name.startsWith('_');
}

export class SLDResolver {
  private kb: KnowledgeBase;
  private config: Required<LogicProgrammingConfig>;

  constructor(kb: KnowledgeBase, config: Partial<LogicProgrammingConfig> = {}) {
    this.kb = kb;
    this.config = { ...getDefaultConfig(), ...config };
  }

  query(goals: CompoundTerm[]): LogicQueryResult {
    const startTime = Date.now();

    const queryVariables: string[] = [];
    for (const goal of goals) {
      for (const name of getVariables(goal)) {
        if (isReportedVariable(name) && !queryVariables.includes(name)) {
          queryVariables.push(name);
        }
      }
    }

    const rootNode = createProofNode(
      { type: 'compound', functor: '?-', args: goals },
      new Map(),
      0
    );

    const solutions: Substitution[] = [];
    const ctx: ResolverContext = {
      kb: this.kb,
      config: this.config,
      startTime,
      exploredNodes: 0,
      maxDepthReached: 0,
      depthLimitHit: false,
      timedOut: false,
      clauseCounter: 0,
      barrierCounter: ROOT_BARRIER,
      onSolution: (subst) => {
        const solution: Substitution = new Map();
        for (const name of queryVariables) {
          const bound = subst.get(name);
          if (bound) solution.set(name, applySubstitution(bound, subst));
        }
        solutions.push(solution);
        return solutions.length >= this.config.maxSolutions;
      },
    };

    let explanation: string | undefined;

    if (this.config.maxSolutions > 0) {
      try {
        resolve(asGoals(goals, ROOT_BARRIER), new Map(), 0, rootNode, ctx);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        explanation = `Resolution aborted: ${error.message}`;
      }
    }

    if (ctx.timedOut) {
      explanation = `Query timed out after ${this.config.timeout}ms`;
    } else if (!explanation && ctx.depthLimitHit && solutions.length === 0) {
      explanation = `Search depth limit (${this.config.maxDepth}) reached`;
    }

    const proofTree: ProofTree = {
      root: rootNode,
      solutions,
      exploredNodes: ctx.exploredNodes,
      maxDepth: ctx.maxDepthReached,
      duration: Date.now() - startTime,
    };

    return {
      success: solutions.length > 0,
      solutions,
      proofTree: this.config.traceExecution ? proofTree : undefined,
      explanation,
      confidence: 1.0,
    };
  }

  prove(goal: CompoundTerm): boolean {
    const result = this.query([goal]);
    return result.success;
  }

  findAll(goal: CompoundTerm, template: Term): Term[] {
    const result = this.query([goal]);
    return result.solutions.map((subst) => applySubstitution(template, subst));
  }

  updateConfig(config: Partial<LogicProgrammingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getKnowledgeBase(): KnowledgeBase {
    return this.kb;
  }
}

export function createResolver(
  kb: KnowledgeBase,
  config?: Partial<LogicProgrammingConfig>
): SLDResolver {
  return new SLDResolver(kb, config);
}

export function queryKnowledgeBase(
  kb: KnowledgeBase,
  queryString: string,
  config?: Partial<LogicProgrammingConfig>
): LogicQueryResult {
  const result = parseQuery(queryString);

  if (!result.success || !result.value) {
    return {
      success: false,
      solutions: [],
      explanation: result.error?.message || 'Parse error',
      confidence: 0,
    };
  }

  const resolver = new SLDResolver(kb, config);
  return resolver.query(result.value);
}

export function formatSolutions(result: LogicQueryResult): string {
  if (!result.success) {
    return 'false.';
  }

  if (result.solutions.length === 0) {
    return 'true.';
  }

  const lines: string[] = [];

  for (const solution of result.solutions) {
    if (solution.size === 0) {
      lines.push('true');
    } else {
      const bindings: string[] = [];
      for (const [varName, term] of solution) {
        if (!varName.startsWith('_')) {
          bindings.push(`${varName} = ${termToString(term)}`);
        }
      }

      if (bindings.length > 0) {
        lines.push(bindings.join(', '));
      } else {
        lines.push('true');
      }
    }
  }

  return lines.join(' ;\n') + '.';
}
