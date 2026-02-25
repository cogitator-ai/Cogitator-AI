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

interface ResolverState {
  goals: CompoundTerm[];
  substitution: Substitution;
  depth: number;
  proofNode: ProofNode;
}

interface ResolverContext {
  kb: KnowledgeBase;
  config: Required<LogicProgrammingConfig>;
  startTime: number;
  exploredNodes: number;
  maxDepth: number;
  solutions: Substitution[];
  queryVariables: Set<string>;
  clauseCounter: number;
}

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

function checkTimeout(ctx: ResolverContext): boolean {
  return Date.now() - ctx.startTime > ctx.config.timeout;
}

function resolve(state: ResolverState, ctx: ResolverContext): { success: boolean; cut?: boolean } {
  ctx.exploredNodes++;

  if (ctx.maxDepth < state.depth) {
    ctx.maxDepth = state.depth;
  }

  if (checkTimeout(ctx)) {
    state.proofNode.status = 'failure';
    return { success: false };
  }

  if (state.depth > ctx.config.maxDepth) {
    state.proofNode.status = 'failure';
    return { success: false };
  }

  if (state.goals.length === 0) {
    state.proofNode.status = 'success';

    const solution = new Map<string, Term>();
    for (const varName of ctx.queryVariables) {
      const bound = state.substitution.get(varName);
      if (bound) {
        solution.set(varName, applySubstitution(bound, state.substitution));
      }
    }

    ctx.solutions.push(solution);
    return { success: true };
  }

  const [currentGoal, ...remainingGoals] = state.goals;
  const resolvedGoal = applySubstitution(currentGoal, state.substitution) as CompoundTerm;

  if (ctx.config.enableCut && resolvedGoal.functor === '!' && resolvedGoal.args.length === 0) {
    state.proofNode.status = 'cut';
    const childNode = createProofNode(resolvedGoal, state.substitution, state.depth + 1);
    childNode.status = 'cut';
    state.proofNode.children.push(childNode);

    const result = resolve(
      {
        goals: remainingGoals,
        substitution: state.substitution,
        depth: state.depth + 1,
        proofNode: childNode,
      },
      ctx
    );

    return { success: result.success, cut: true };
  }

  if (
    ctx.config.enableNegation &&
    resolvedGoal.functor === '\\+' &&
    resolvedGoal.args.length === 1 &&
    resolvedGoal.args[0].type === 'compound'
  ) {
    const negatedGoal = resolvedGoal.args[0] as CompoundTerm;
    const childNode = createProofNode(resolvedGoal, state.substitution, state.depth + 1);
    state.proofNode.children.push(childNode);

    const savedSolutions = ctx.solutions.length;

    const testNode = createProofNode(negatedGoal, state.substitution, state.depth + 1);
    const testResult = resolve(
      {
        goals: [negatedGoal],
        substitution: state.substitution,
        depth: state.depth + 1,
        proofNode: testNode,
      },
      ctx
    );

    ctx.solutions.length = savedSolutions;

    if (!testResult.success) {
      childNode.status = 'success';

      return resolve(
        {
          goals: remainingGoals,
          substitution: state.substitution,
          depth: state.depth + 1,
          proofNode: childNode,
        },
        ctx
      );
    }

    childNode.status = 'failure';
    return { success: false };
  }

  if (resolvedGoal.functor === ',' && resolvedGoal.args.length === 2) {
    const [first, second] = resolvedGoal.args;
    if (first.type === 'compound' && second.type === 'compound') {
      const newGoals = [first as CompoundTerm, second as CompoundTerm, ...remainingGoals];
      return resolve(
        {
          goals: newGoals,
          substitution: state.substitution,
          depth: state.depth,
          proofNode: state.proofNode,
        },
        ctx
      );
    }
  }

  if (resolvedGoal.functor === ';' && resolvedGoal.args.length === 2) {
    const [first, second] = resolvedGoal.args;

    if (first.type === 'compound') {
      const firstNode = createProofNode(first as CompoundTerm, state.substitution, state.depth + 1);
      state.proofNode.children.push(firstNode);

      const firstResult = resolve(
        {
          goals: [first as CompoundTerm, ...remainingGoals],
          substitution: state.substitution,
          depth: state.depth + 1,
          proofNode: firstNode,
        },
        ctx
      );

      if (firstResult.cut) {
        return firstResult;
      }
    }

    if (second.type === 'compound') {
      const secondNode = createProofNode(
        second as CompoundTerm,
        state.substitution,
        state.depth + 1
      );
      state.proofNode.children.push(secondNode);

      return resolve(
        {
          goals: [second as CompoundTerm, ...remainingGoals],
          substitution: state.substitution,
          depth: state.depth + 1,
          proofNode: secondNode,
        },
        ctx
      );
    }

    return { success: false };
  }

  if (resolvedGoal.functor === '->' && resolvedGoal.args.length === 2) {
    const [condition, thenBranch] = resolvedGoal.args;

    if (condition.type === 'compound' && thenBranch.type === 'compound') {
      const condNode = createProofNode(
        condition as CompoundTerm,
        state.substitution,
        state.depth + 1
      );
      state.proofNode.children.push(condNode);

      const savedSolutions = ctx.solutions.length;
      const savedQueryVars = ctx.queryVariables;

      const condVars = getVariables(condition as CompoundTerm);
      const thenVars = getVariables(thenBranch as CompoundTerm);
      const allVars = new Set([...savedQueryVars, ...condVars, ...thenVars]);
      for (const [k] of state.substitution) allVars.add(k);
      ctx.queryVariables = allVars;

      const condResult = resolve(
        {
          goals: [condition as CompoundTerm],
          substitution: state.substitution,
          depth: state.depth + 1,
          proofNode: condNode,
        },
        ctx
      );

      ctx.queryVariables = savedQueryVars;

      if (condResult.success && ctx.solutions.length > savedSolutions) {
        const condSolution = ctx.solutions[savedSolutions];
        ctx.solutions.length = savedSolutions;

        const merged = new Map(state.substitution);
        for (const [k, v] of condSolution) {
          merged.set(k, v);
        }

        return resolve(
          {
            goals: [thenBranch as CompoundTerm, ...remainingGoals],
            substitution: merged,
            depth: state.depth + 1,
            proofNode: condNode,
          },
          ctx
        );
      }

      ctx.solutions.length = savedSolutions;
      return { success: false };
    }
  }

  if (isBuiltin(resolvedGoal.functor, resolvedGoal.args.length)) {
    const childNode = createProofNode(resolvedGoal, state.substitution, state.depth + 1);
    state.proofNode.children.push(childNode);

    const builtinResult = executeBuiltin(resolvedGoal, state.substitution);

    if (builtinResult.cut) {
      childNode.status = 'cut';
      if (builtinResult.substitutions.length > 0) {
        const result = resolve(
          {
            goals: remainingGoals,
            substitution: builtinResult.substitutions[0],
            depth: state.depth + 1,
            proofNode: childNode,
          },
          ctx
        );
        return { success: result.success, cut: true };
      }
      return { success: false, cut: true };
    }

    if (!builtinResult.success) {
      childNode.status = 'failure';
      return { success: false };
    }

    let anySuccess = false;

    for (const newSubst of builtinResult.substitutions) {
      if (ctx.solutions.length >= ctx.config.maxSolutions) {
        break;
      }

      const branchNode = createProofNode(resolvedGoal, newSubst, state.depth + 1);
      childNode.children.push(branchNode);

      const result = resolve(
        {
          goals: remainingGoals,
          substitution: newSubst,
          depth: state.depth + 1,
          proofNode: branchNode,
        },
        ctx
      );

      if (result.success) {
        anySuccess = true;
        branchNode.status = 'success';
      }

      if (result.cut) {
        childNode.status = anySuccess ? 'success' : 'failure';
        return { success: anySuccess, cut: true };
      }
    }

    childNode.status = anySuccess ? 'success' : 'failure';
    return { success: anySuccess };
  }

  const clauses = ctx.kb.getClauses(resolvedGoal.functor, resolvedGoal.args.length);

  if (clauses.length === 0) {
    state.proofNode.status = 'failure';
    return { success: false };
  }

  let anySuccess = false;

  for (const clause of clauses) {
    if (ctx.solutions.length >= ctx.config.maxSolutions) {
      break;
    }

    ctx.clauseCounter++;
    const renamedClause = renameClause(clause, `_${ctx.clauseCounter}`);

    const unifyResult = unify(resolvedGoal, renamedClause.head, state.substitution);

    if (unifyResult === null) {
      continue;
    }

    const childNode = createProofNode(resolvedGoal, unifyResult, state.depth + 1);
    childNode.clause = renamedClause;
    state.proofNode.children.push(childNode);

    const newGoals = [...renamedClause.body, ...remainingGoals];

    const result = resolve(
      {
        goals: newGoals,
        substitution: unifyResult,
        depth: state.depth + 1,
        proofNode: childNode,
      },
      ctx
    );

    if (result.success) {
      anySuccess = true;
      childNode.status = 'success';
    } else {
      childNode.status = 'failure';
    }

    if (result.cut && ctx.config.enableCut) {
      break;
    }
  }

  state.proofNode.status = anySuccess ? 'success' : 'failure';
  return { success: anySuccess };
}

function renameClause(clause: Clause, suffix: string): Clause {
  return {
    head: renameVariables(clause.head, suffix) as CompoundTerm,
    body: clause.body.map((g) => renameVariables(g, suffix) as CompoundTerm),
    metadata: clause.metadata,
  };
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

    const queryVars = new Set<string>();
    for (const goal of goals) {
      for (const v of getVariables(goal)) {
        queryVars.add(v);
      }
    }

    const rootNode = createProofNode(
      { type: 'compound', functor: '?-', args: goals },
      new Map(),
      0
    );

    const ctx: ResolverContext = {
      kb: this.kb,
      config: this.config,
      startTime,
      exploredNodes: 0,
      maxDepth: 0,
      solutions: [],
      queryVariables: queryVars,
      clauseCounter: 0,
    };

    const state: ResolverState = {
      goals,
      substitution: new Map(),
      depth: 0,
      proofNode: rootNode,
    };

    resolve(state, ctx);

    const duration = Date.now() - startTime;

    const proofTree: ProofTree = {
      root: rootNode,
      solutions: ctx.solutions,
      exploredNodes: ctx.exploredNodes,
      maxDepth: ctx.maxDepth,
      duration,
    };

    return {
      success: ctx.solutions.length > 0,
      solutions: ctx.solutions,
      proofTree: this.config.traceExecution ? proofTree : undefined,
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
