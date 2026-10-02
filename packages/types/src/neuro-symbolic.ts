/**
 * Neuro-Symbolic AI types
 *
 * Hybrid neural-symbolic reasoning combining:
 * - LLM-based understanding (neural)
 * - Formal reasoning methods (symbolic)
 *
 * Four modules:
 * 1. Knowledge Graph Query Language - SPARQL-like queries + NL interface
 * 2. Logic Programming - Prolog-style rules with unification
 * 3. Constraint Solving - SAT/SMT with Z3
 * 4. Formal Plan Verification - Action schemas + validation
 */

import type { GraphNode, GraphEdge, GraphAdapter } from './knowledge-graph';

export type QueryOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'in'
  | 'notIn';

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface QueryCondition {
  field: string;
  operator: QueryOperator;
  value: unknown;
}

export interface QueryVariable {
  name: string;
  type?: 'node' | 'edge' | 'value';
}

export interface QueryPattern {
  subject?: string | QueryVariable;
  predicate?: string | QueryVariable;
  object?: string | QueryVariable;
  conditions?: QueryCondition[];
}

export type GraphQueryType = 'select' | 'ask' | 'construct' | 'describe';

export interface GraphQuery {
  type: GraphQueryType;
  patterns: QueryPattern[];
  filters?: QueryCondition[];
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
  aggregates?: { function: AggregateFunction; field: string; alias: string }[];
  groupBy?: string[];
}

export type QueryBinding = Record<string, GraphNode | GraphEdge | unknown>;

export interface GraphQueryResult {
  bindings: QueryBinding[];
  count: number;
  executionTime: number;
  explain?: string;
}

export interface NaturalLanguageQueryResult {
  query: GraphQuery;
  results: GraphQueryResult;
  naturalLanguageResponse: string;
  confidence: number;
}

export type TermType = 'atom' | 'variable' | 'compound' | 'number' | 'string' | 'list';

export interface BaseTerm {
  type: TermType;
}

export interface AtomTerm extends BaseTerm {
  type: 'atom';
  value: string;
}

export interface VariableTerm extends BaseTerm {
  type: 'variable';
  name: string;
}

export interface NumberTerm extends BaseTerm {
  type: 'number';
  value: number;
}

export interface StringTerm extends BaseTerm {
  type: 'string';
  value: string;
}

export interface CompoundTerm extends BaseTerm {
  type: 'compound';
  functor: string;
  args: Term[];
}

export interface ListTerm extends BaseTerm {
  type: 'list';
  elements: Term[];
  tail?: Term;
}

export type Term = AtomTerm | VariableTerm | NumberTerm | StringTerm | CompoundTerm | ListTerm;

export interface Clause {
  head: CompoundTerm;
  body: CompoundTerm[];
  metadata?: {
    source?: string;
    confidence?: number;
    timestamp?: Date;
  };
}

export interface LogicFact extends Clause {
  body: [];
}

export interface Rule extends Clause {
  body: CompoundTerm[];
}

export type Substitution = Map<string, Term>;

export type ProofNodeStatus = 'success' | 'failure' | 'pending' | 'cut';

export interface ProofNode {
  id: string;
  goal: CompoundTerm;
  clause?: Clause;
  substitution: Substitution;
  children: ProofNode[];
  status: ProofNodeStatus;
  depth: number;
}

export interface ProofTree {
  root: ProofNode;
  solutions: Substitution[];
  exploredNodes: number;
  maxDepth: number;
  duration: number;
}

export interface LogicQueryResult {
  success: boolean;
  solutions: Substitution[];
  proofTree?: ProofTree;
  explanation?: string;
  confidence: number;
}

export interface KnowledgeBaseStats {
  factCount: number;
  ruleCount: number;
  predicates: string[];
  avgRuleBodyLength: number;
}

export interface LogicProgrammingConfig {
  maxDepth?: number;
  maxSolutions?: number;
  timeout?: number;
  enableCut?: boolean;
  enableNegation?: boolean;
  traceExecution?: boolean;
}

export type BuiltinPredicate =
  | 'is'
  | 'unify'
  | 'not'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'neq'
  | 'member'
  | 'append'
  | 'length'
  | 'reverse'
  | 'sort'
  | 'atom'
  | 'number'
  | 'compound'
  | 'var'
  | 'nonvar'
  | 'is_list'
  | 'findall'
  | 'bagof'
  | 'setof'
  | 'assert'
  | 'retract'
  | 'write'
  | 'nl'
  | 'read'
  | 'functor'
  | 'arg'
  | 'copy_term'
  | 'call'
  | 'true'
  | 'false'
  | 'fail'
  | 'cut';

export type ConstraintVariableType = 'bool' | 'int' | 'real' | 'bitvec';

export interface ConstraintVariable {
  name: string;
  type: ConstraintVariableType;
  domain?: { min?: number; max?: number };
  bitWidth?: number;
}

export type ConstraintOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'and'
  | 'or'
  | 'not'
  | 'implies'
  | 'iff'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'abs'
  | 'min'
  | 'max'
  | 'pow'
  | 'allDifferent'
  | 'atMost'
  | 'atLeast'
  | 'exactly'
  | 'ite';

export type ConstraintExpressionType = 'variable' | 'constant' | 'operation';

export interface VariableExpression {
  type: 'variable';
  name: string;
}

export interface ConstantExpression {
  type: 'constant';
  value: boolean | number;
}

export interface OperationExpression {
  type: 'operation';
  operator: ConstraintOperator;
  operands: ConstraintExpression[];
}

export type ConstraintExpression = VariableExpression | ConstantExpression | OperationExpression;

export interface Constraint {
  id: string;
  name?: string;
  expression: ConstraintExpression;
  weight?: number;
  isHard: boolean;
}

export type OptimizationType = 'minimize' | 'maximize';

export interface ConstraintProblem {
  id: string;
  name?: string;
  variables: ConstraintVariable[];
  constraints: Constraint[];
  objective?: {
    type: OptimizationType;
    expression: ConstraintExpression;
  };
}

export type SolverStatus = 'sat' | 'unsat' | 'unknown' | 'timeout' | 'error';

export interface ConstraintModel {
  assignments: Record<string, boolean | number>;
  objectiveValue?: number;
}

export type SolverResult =
  | { status: 'sat'; model: ConstraintModel }
  | { status: 'unsat'; unsatCore?: string[] }
  | { status: 'unknown'; reason: string }
  | { status: 'timeout' }
  | { status: 'error'; message: string };

export type ConstraintSolverType = 'z3' | 'simple-sat';

export interface ConstraintSolverConfig {
  timeout?: number;
  solver?: ConstraintSolverType;
  enableOptimization?: boolean;
  randomSeed?: number;
}

export interface ConstraintSolvingResult {
  problem: ConstraintProblem;
  result: SolverResult;
  explanation?: string;
  duration: number;
}

export type StateVariableType = 'boolean' | 'numeric' | 'enum' | 'string' | 'object';

export interface StateVariable {
  name: string;
  type: StateVariableType;
  domain?: string[] | { min: number; max: number };
  initialValue?: unknown;
}

export interface PlanState {
  id: string;
  variables: Record<string, unknown>;
  timestamp?: Date;
}

export type PreconditionType = 'simple' | 'comparison' | 'exists' | 'forall' | 'and' | 'or' | 'not';

export interface SimplePrecondition {
  type: 'simple';
  variable: string;
  value: unknown;
}

export interface ComparisonPrecondition {
  type: 'comparison';
  variable: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
  value: unknown;
}

export interface ExistsPrecondition {
  type: 'exists';
  variable: string;
  domain: string;
  condition: Precondition;
}

export interface ForallPrecondition {
  type: 'forall';
  variable: string;
  domain: string;
  condition: Precondition;
}

export interface AndPrecondition {
  type: 'and';
  conditions: Precondition[];
}

export interface OrPrecondition {
  type: 'or';
  conditions: Precondition[];
}

export interface NotPrecondition {
  type: 'not';
  condition: Precondition;
}

export type Precondition =
  | SimplePrecondition
  | ComparisonPrecondition
  | ExistsPrecondition
  | ForallPrecondition
  | AndPrecondition
  | OrPrecondition
  | NotPrecondition;

export type EffectType = 'assign' | 'increment' | 'decrement' | 'delete' | 'conditional';

export interface AssignEffect {
  type: 'assign';
  variable: string;
  value: unknown;
}

export interface IncrementEffect {
  type: 'increment';
  variable: string;
  amount: number;
}

export interface DecrementEffect {
  type: 'decrement';
  variable: string;
  amount: number;
}

export interface DeleteEffect {
  type: 'delete';
  variable: string;
}

export interface ConditionalEffect {
  type: 'conditional';
  condition: Precondition;
  thenEffects: Effect[];
  elseEffects?: Effect[];
}

export type Effect =
  AssignEffect | IncrementEffect | DecrementEffect | DeleteEffect | ConditionalEffect;

export interface ActionParameter {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface ActionSchema {
  name: string;
  description?: string;
  parameters: ActionParameter[];
  preconditions: Precondition[];
  effects: Effect[];
  cost?: number;
  duration?: number;
}

export interface PlanAction {
  id: string;
  schemaName: string;
  parameters: Record<string, unknown>;
  expectedDuration?: number;
}

export interface Plan {
  id: string;
  name?: string;
  actions: PlanAction[];
  initialState: PlanState;
  goalConditions: Precondition[];
  metadata?: Record<string, unknown>;
}

export type SafetyPropertyType = 'invariant' | 'eventually' | 'always' | 'never' | 'until';

export interface SafetyProperty {
  id: string;
  name: string;
  description?: string;
  type: SafetyPropertyType;
  condition: Precondition;
}

export type ValidationErrorType =
  | 'precondition_violated'
  | 'undefined_action'
  | 'invalid_parameter'
  | 'missing_parameter'
  | 'goal_unreachable'
  | 'invariant_violated';

export interface PlanValidationError {
  type: ValidationErrorType;
  actionIndex?: number;
  actionName?: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationWarningType = 'redundant_action' | 'suboptimal_ordering' | 'unused_effect';

export interface PlanValidationWarning {
  type: ValidationWarningType;
  actionIndex?: number;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
  warnings: PlanValidationWarning[];
  stateTrace: PlanState[];
  satisfiedGoals: string[];
  unsatisfiedGoals: string[];
}

export interface InvariantCheckResult {
  property: SafetyProperty;
  satisfied: boolean;
  violatingStates?: PlanState[];
  counterexample?: PlanAction[];
}

export type DependencyType = 'causal' | 'threat' | 'ordering';

export interface DependencyEdge {
  fromAction: string;
  toAction: string;
  type: DependencyType;
  variable?: string;
  description?: string;
}

export interface DependencyGraph {
  actions: string[];
  edges: DependencyEdge[];
  criticalPath: string[];
  parallelizable: string[][];
}

export type RepairType = 'insert' | 'remove' | 'reorder' | 'modify';

export interface PlanRepairSuggestion {
  type: RepairType;
  position?: number;
  action?: PlanAction;
  reason: string;
  confidence: number;
}

export interface PlanRepairResult {
  originalPlan: Plan;
  repairedPlan?: Plan;
  suggestions: PlanRepairSuggestion[];
  success: boolean;
  explanation: string;
}

export interface NeuroSymbolicConfig {
  knowledgeGraph?: {
    adapter?: GraphAdapter;
    enableNaturalLanguage?: boolean;
    defaultQueryLimit?: number;
  };
  logic?: LogicProgrammingConfig;
  constraints?: ConstraintSolverConfig;
  planning?: {
    maxPlanLength?: number;
    enableRepair?: boolean;
    verifyInvariants?: boolean;
  };
}

export const DEFAULT_LOGIC_CONFIG: Required<LogicProgrammingConfig> = {
  maxDepth: 50,
  maxSolutions: 10,
  timeout: 5000,
  enableCut: true,
  enableNegation: true,
  traceExecution: false,
};

export const DEFAULT_CONSTRAINT_CONFIG: Required<ConstraintSolverConfig> = {
  timeout: 10000,
  solver: 'z3',
  enableOptimization: true,
  randomSeed: 42,
};

export const DEFAULT_NEURO_SYMBOLIC_CONFIG: NeuroSymbolicConfig = {
  knowledgeGraph: {
    enableNaturalLanguage: true,
    defaultQueryLimit: 100,
  },
  logic: DEFAULT_LOGIC_CONFIG,
  constraints: DEFAULT_CONSTRAINT_CONFIG,
  planning: {
    maxPlanLength: 100,
    enableRepair: true,
    verifyInvariants: true,
  },
};

export interface NeuroSymbolicResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  duration: number;
  llmCalls?: number;
}
