export {
  unify,
  applySubstitution,
  composeSubstitutions,
  getVariables,
  renameVariables,
  termsEqual,
  occursIn,
  termToString,
  substitutionToString,
  isAtom,
  isVariable,
  isNumber,
  isString,
  isCompound,
  isList,
} from './unification';

export {
  parseTerm,
  parseClause,
  parseProgram,
  parseQuery,
  termFromValue,
  termToValue,
} from './parser';

export { KnowledgeBase, createKnowledgeBase, type KnowledgeBaseOptions } from './knowledge-base';

export {
  isBuiltin,
  isControlConstruct,
  executeBuiltin,
  getBuiltinList,
  type BuiltinResult,
} from './builtins';

export { SLDResolver, createResolver, queryKnowledgeBase, formatSolutions } from './resolver';

export {
  formatProofTree,
  formatProofPath,
  extractProofPaths,
  analyzeProofTree,
  pruneProofTree,
  proofTreeToMermaid,
  proofTreeToJSON,
  type ProofTreeOptions,
  type ProofPath,
  type ProofStats,
} from './proof-tree';

export {
  createNLToQueryPrompt,
  createNLToFactsPrompt,
  createNLToRulesPrompt,
  createExplainResultPrompt,
  createGenerateQueriesPrompt,
  createDebugQueryPrompt,
  formatQueryForLLM,
  formatClauseForLLM,
  formatKnowledgeBaseForLLM,
  parseLLMQueryResponse,
  parseLLMFactsResponse,
  type NLToLogicPromptContext,
  type NLToFactsPromptContext,
  type NLToRulesPromptContext,
  type ExplainResultPromptContext,
  type GenerateQueriesPromptContext,
  type DebugQueryPromptContext,
  type ParseLLMResponseResult,
} from './prompts';
