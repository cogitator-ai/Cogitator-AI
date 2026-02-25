import type {
  GraphAdapter,
  GraphQuery,
  GraphQueryResult,
  NaturalLanguageQueryResult,
  Plan,
  ActionSchema,
  PlanValidationResult,
  PlanRepairResult,
  InvariantCheckResult,
  SafetyProperty,
  ConstraintProblem,
  SolverResult,
  LogicQueryResult,
  NeuroSymbolicConfig,
  NeuroSymbolicResult,
} from '@cogitator-ai/types';

import {
  KnowledgeBase,
  createKnowledgeBase,
  SLDResolver,
  createResolver,
  parseQuery,
  formatSolutions,
} from './logic';

import {
  GraphQueryBuilder,
  executeQuery,
  executeNLQuery,
  ReasoningEngine,
  createReasoningEngine,
  type QueryExecutionContext,
  type NLQueryContext,
} from './knowledge-graph';

import { ConstraintBuilder, solve, isZ3Available } from './constraints';

import {
  ActionRegistry,
  validatePlan,
  InvariantChecker,
  createInvariantChecker,
  PlanRepairer,
  createPlanRepairer,
} from './planning';

export interface NeuroSymbolicOptions {
  config?: Partial<NeuroSymbolicConfig>;
  graphAdapter?: GraphAdapter;
  agentId?: string;
}

export class NeuroSymbolic {
  private config: NeuroSymbolicConfig;
  private knowledgeBase: KnowledgeBase;
  private resolver: SLDResolver;
  private actionRegistry: ActionRegistry;
  private invariantChecker: InvariantChecker;
  private planRepairer: PlanRepairer;
  private graphAdapter?: GraphAdapter;
  private reasoningEngine?: ReasoningEngine;
  private agentId: string;

  constructor(options: NeuroSymbolicOptions = {}) {
    this.config = {
      knowledgeGraph: {
        enableNaturalLanguage: true,
        defaultQueryLimit: 100,
        ...options.config?.knowledgeGraph,
      },
      logic: {
        maxDepth: 50,
        maxSolutions: 10,
        timeout: 5000,
        enableCut: true,
        enableNegation: true,
        traceExecution: false,
        ...options.config?.logic,
      },
      constraints: {
        timeout: 10000,
        solver: 'z3',
        enableOptimization: true,
        randomSeed: 42,
        ...options.config?.constraints,
      },
      planning: {
        maxPlanLength: 100,
        enableRepair: true,
        verifyInvariants: true,
        ...options.config?.planning,
      },
    };

    this.agentId = options.agentId || 'default';
    this.graphAdapter = options.graphAdapter;

    this.knowledgeBase = createKnowledgeBase();
    this.resolver = createResolver(this.knowledgeBase, this.config.logic);
    this.actionRegistry = new ActionRegistry();
    this.invariantChecker = createInvariantChecker(this.actionRegistry);
    this.planRepairer = createPlanRepairer(this.actionRegistry);

    if (this.graphAdapter) {
      this.reasoningEngine = createReasoningEngine(this.graphAdapter, this.agentId, {
        maxHops: 3,
        minConfidence: 0.5,
      });
    }
  }

  loadLogicProgram(program: string): { success: boolean; errors: string[] } {
    return this.knowledgeBase.consult(program);
  }

  assertFact(predicate: string, ...args: unknown[]): void {
    const terms = args.map((arg) => {
      if (typeof arg === 'string') {
        return { type: 'atom' as const, value: arg };
      }
      if (typeof arg === 'number') {
        return { type: 'number' as const, value: arg };
      }
      return { type: 'atom' as const, value: String(arg) };
    });

    this.knowledgeBase.assertFact(predicate, terms);
  }

  queryLogic(queryString: string): NeuroSymbolicResult<LogicQueryResult> {
    const startTime = Date.now();

    const parseResult = parseQuery(queryString);
    if (!parseResult.success || !parseResult.value) {
      return {
        success: false,
        error: parseResult.error?.message || 'Parse error',
        duration: Date.now() - startTime,
      };
    }

    const result = this.resolver.query(parseResult.value);

    return {
      success: result.success,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  proveLogic(queryString: string): NeuroSymbolicResult<boolean> {
    const startTime = Date.now();
    const result = this.queryLogic(queryString);

    return {
      success: true,
      data: result.success && (result.data?.success ?? false),
      duration: Date.now() - startTime,
    };
  }

  getLogicSolutions(queryString: string): string {
    const result = this.queryLogic(queryString);
    if (!result.success || !result.data) {
      return 'Error: ' + (result.error || 'Unknown error');
    }
    return formatSolutions(result.data);
  }

  async queryGraph(query: GraphQuery): Promise<NeuroSymbolicResult<GraphQueryResult>> {
    const startTime = Date.now();

    if (!this.graphAdapter) {
      return {
        success: false,
        error: 'Graph adapter not configured',
        duration: Date.now() - startTime,
      };
    }

    const ctx: QueryExecutionContext = {
      adapter: this.graphAdapter,
      agentId: this.agentId,
      variables: new Map(),
    };

    const result = await executeQuery(query, ctx);

    return {
      success: true,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  async askGraph(question: string): Promise<NeuroSymbolicResult<NaturalLanguageQueryResult>> {
    const startTime = Date.now();

    if (!this.graphAdapter) {
      return {
        success: false,
        error: 'Graph adapter not configured',
        duration: Date.now() - startTime,
      };
    }

    const ctx: NLQueryContext = {
      adapter: this.graphAdapter,
      agentId: this.agentId,
    };

    const result = await executeNLQuery(question, ctx);

    return {
      success: true,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  createGraphQuery(): GraphQueryBuilder {
    return GraphQueryBuilder.select();
  }

  async findPath(startNodeId: string, endNodeId: string): Promise<NeuroSymbolicResult<unknown>> {
    const startTime = Date.now();

    if (!this.reasoningEngine) {
      return {
        success: false,
        error: 'Reasoning engine not configured',
        duration: Date.now() - startTime,
      };
    }

    const result = await this.reasoningEngine.findPath(startNodeId, endNodeId);

    return {
      success: result.paths.length > 0,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  createConstraintProblem(name?: string): ConstraintBuilder {
    return ConstraintBuilder.create(name);
  }

  async solve(problem: ConstraintProblem): Promise<NeuroSymbolicResult<SolverResult>> {
    const startTime = Date.now();

    const result = await solve(problem, this.config.constraints);

    return {
      success: true,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  async checkZ3Available(): Promise<boolean> {
    return isZ3Available();
  }

  registerAction(schema: ActionSchema): void {
    this.actionRegistry.register(schema);
  }

  registerActions(schemas: ActionSchema[]): void {
    for (const schema of schemas) {
      this.actionRegistry.register(schema);
    }
  }

  getRegisteredActions(): ActionSchema[] {
    return this.actionRegistry.getAll();
  }

  validatePlan(plan: Plan): NeuroSymbolicResult<PlanValidationResult> {
    const startTime = Date.now();

    const result = validatePlan(plan, this.actionRegistry);

    return {
      success: result.valid,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  addSafetyProperty(property: SafetyProperty): void {
    this.invariantChecker.addProperty(property);
  }

  checkInvariants(plan: Plan): NeuroSymbolicResult<InvariantCheckResult[]> {
    const startTime = Date.now();

    const results = this.invariantChecker.checkPlan(plan);
    const allSatisfied = results.every((r) => r.satisfied);

    return {
      success: allSatisfied,
      data: results,
      duration: Date.now() - startTime,
    };
  }

  repairPlan(plan: Plan): NeuroSymbolicResult<PlanRepairResult> {
    const startTime = Date.now();

    if (!this.config.planning?.enableRepair) {
      return {
        success: false,
        error: 'Plan repair is disabled',
        duration: Date.now() - startTime,
      };
    }

    const result = this.planRepairer.repair(plan);

    return {
      success: result.success,
      data: result,
      duration: Date.now() - startTime,
    };
  }

  async validateAndRepair(plan: Plan): Promise<
    NeuroSymbolicResult<{
      validation: PlanValidationResult;
      invariants?: InvariantCheckResult[];
      repair?: PlanRepairResult;
      finalPlan: Plan;
    }>
  > {
    const startTime = Date.now();

    const validation = validatePlan(plan, this.actionRegistry);

    let invariants: InvariantCheckResult[] | undefined;
    if (this.config.planning?.verifyInvariants) {
      invariants = this.invariantChecker.checkPlan(plan);
    }

    let repair: PlanRepairResult | undefined;
    let finalPlan = plan;

    if (!validation.valid && this.config.planning?.enableRepair) {
      repair = this.planRepairer.repair(plan);
      if (repair.success && repair.repairedPlan) {
        finalPlan = repair.repairedPlan;
      }
    }

    const success = validation.valid || (repair?.success ?? false);

    return {
      success,
      data: {
        validation,
        invariants,
        repair,
        finalPlan,
      },
      duration: Date.now() - startTime,
    };
  }

  getKnowledgeBase(): KnowledgeBase {
    return this.knowledgeBase;
  }

  getActionRegistry(): ActionRegistry {
    return this.actionRegistry;
  }

  getConfig(): NeuroSymbolicConfig {
    return {
      logic: { ...this.config.logic },
      constraints: { ...this.config.constraints },
      planning: { ...this.config.planning },
      knowledgeGraph: { ...this.config.knowledgeGraph },
    };
  }

  updateConfig(config: Partial<NeuroSymbolicConfig>): void {
    if (config.logic) {
      this.config.logic = { ...this.config.logic, ...config.logic };
      this.resolver = createResolver(this.knowledgeBase, this.config.logic);
    }

    if (config.constraints) {
      this.config.constraints = { ...this.config.constraints, ...config.constraints };
    }

    if (config.planning) {
      this.config.planning = { ...this.config.planning, ...config.planning };
    }

    if (config.knowledgeGraph) {
      this.config.knowledgeGraph = { ...this.config.knowledgeGraph, ...config.knowledgeGraph };
    }
  }

  reset(): void {
    this.knowledgeBase.clear();
    this.actionRegistry.clear();
    this.resolver = createResolver(this.knowledgeBase, this.config.logic);
    this.invariantChecker = createInvariantChecker(this.actionRegistry);
    this.planRepairer = createPlanRepairer(this.actionRegistry);
  }
}

export function createNeuroSymbolic(options?: NeuroSymbolicOptions): NeuroSymbolic {
  return new NeuroSymbolic(options);
}
