import type {
  GraphQuery,
  GraphQueryResult,
  NaturalLanguageQueryResult,
  GraphAdapter,
  GraphNode,
  GraphEdge,
  EntityType,
  RelationType,
  QueryOperator,
  QueryVariable,
} from '@cogitator-ai/types';
import { executeQuery, GraphQueryBuilder, variable } from './query-language';
import { extractJSON } from './utils';

export interface NLQueryContext {
  adapter: GraphAdapter;
  agentId: string;
  entityTypes?: EntityType[];
  relationTypes?: RelationType[];
  examples?: { question: string; query: GraphQuery }[];
}

export interface NLQueryAnalysis {
  intent: 'find' | 'check' | 'count' | 'describe' | 'compare';
  entities: string[];
  relations: string[];
  constraints: { field: string; operator: string; value: string }[];
  variables: string[];
}

const RELATION_KEYWORDS: [string, RelationType][] = [
  ['works at', 'works_at'],
  ['works for', 'works_at'],
  ['employed by', 'works_at'],
  ['knows', 'knows'],
  ['friends with', 'knows'],
  ['related to', 'related_to'],
  ['located in', 'located_in'],
  ['lives in', 'located_in'],
  ['based in', 'located_in'],
  ['part of', 'part_of'],
  ['member of', 'part_of'],
  ['belongs to', 'belongs_to'],
  ['created by', 'created_by'],
  ['made by', 'created_by'],
  ['built by', 'created_by'],
  ['connected to', 'associated_with'],
  ['linked to', 'associated_with'],
  ['associated with', 'associated_with'],
  ['causes', 'causes'],
  ['caused by', 'causes'],
  ['precedes', 'precedes'],
];

export function analyzeNLQuery(question: string): NLQueryAnalysis {
  const lower = question.toLowerCase();
  const analysis: NLQueryAnalysis = {
    intent: 'find',
    entities: [],
    relations: [],
    constraints: [],
    variables: [],
  };

  if (/^(is|are|does|do|did|was|were|has|have|can)\b/.test(lower)) {
    analysis.intent = 'check';
  } else if (/^how many\b/.test(lower) || /\bcount\b/.test(lower)) {
    analysis.intent = 'count';
  } else if (/^(what is|what's|who is|who's|describe|tell me about)\b/.test(lower)) {
    analysis.intent = 'describe';
  } else if (/\b(compare|difference between)\b/.test(lower)) {
    analysis.intent = 'compare';
  }

  const quotedPattern = /"([^"]+)"/g;
  let match;
  while ((match = quotedPattern.exec(question)) !== null) {
    analysis.entities.push(match[1]);
  }

  const stopWords = new Set([
    'What',
    'Who',
    'Where',
    'When',
    'Why',
    'How',
    'Which',
    'Does',
    'Did',
    'Can',
    'Could',
    'Would',
    'Should',
    'The',
    'This',
    'That',
    'These',
    'Those',
    'Tell',
    'Find',
    'Show',
    'Get',
    'List',
    'Give',
    'Are',
    'Is',
    'Was',
    'Were',
    'Has',
    'Have',
    'Had',
    'And',
    'But',
    'Or',
    'Not',
    'All',
    'Any',
    'Some',
    'Each',
    'Every',
    'About',
    'From',
    'Into',
    'With',
    'Between',
    'Through',
    'During',
    'Before',
    'After',
    'Above',
    'Below',
    'Do',
    'Many',
    'Much',
    'More',
    'Most',
    'Other',
  ]);

  const capitalizedPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  while ((match = capitalizedPattern.exec(question)) !== null) {
    const word = match[1];
    if (!stopWords.has(word)) {
      analysis.entities.push(word);
    }
  }

  for (const [keyword, relation] of RELATION_KEYWORDS) {
    if (new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`).test(lower)) {
      if (!analysis.relations.includes(relation)) analysis.relations.push(relation);
    }
  }

  const questionVariables: [RegExp, string][] = [
    [/\bwho\b/, 'person'],
    [/\bwhat\b/, 'thing'],
    [/\bwhere\b/, 'location'],
    [/\bwhen\b/, 'time'],
  ];
  for (const [pattern, name] of questionVariables) {
    if (pattern.test(lower)) analysis.variables.push(name);
  }

  analysis.entities = Array.from(new Set(analysis.entities));

  return analysis;
}

export function buildQueryFromAnalysis(analysis: NLQueryAnalysis): GraphQuery {
  const [first, second] = analysis.entities;
  const relation = analysis.relations[0];
  const entityOnly = analysis.entities.length === 1 && !relation;

  const builder = entityOnly
    ? GraphQueryBuilder.describe()
    : analysis.intent === 'check'
      ? GraphQueryBuilder.ask()
      : GraphQueryBuilder.select();

  if (analysis.intent === 'count') {
    builder.count('*', 'count');
  }

  if (first !== undefined && second !== undefined && relation) {
    builder.where(first, relation, second);
  } else if (first !== undefined && relation) {
    builder.where(variable('X'), relation, first);
  } else if (first !== undefined) {
    builder.where(first, variable('relation'), variable('related'));
  } else if (relation) {
    builder.where(variable('X'), relation, variable('Y'));
  } else if (analysis.variables.length > 0) {
    builder.where(variable('X'), variable('relation'), variable('Y'));
  }

  if (analysis.intent !== 'count') {
    builder.limit(20);
  }

  return builder.build();
}

export interface NLQueryPromptContext {
  question: string;
  availableEntityTypes: EntityType[];
  availableRelationTypes: RelationType[];
  sampleEntities?: string[];
  sampleRelations?: string[];
}

export function createNLToGraphQueryPrompt(ctx: NLQueryPromptContext): string {
  return `You are a knowledge graph query expert. Convert the natural language question into a structured graph query.

Available entity types: ${ctx.availableEntityTypes.join(', ')}
Available relation types: ${ctx.availableRelationTypes.join(', ')}
${ctx.sampleEntities ? `Sample entities: ${ctx.sampleEntities.slice(0, 10).join(', ')}` : ''}
${ctx.sampleRelations ? `Sample relations: ${ctx.sampleRelations.slice(0, 10).join(', ')}` : ''}

Question: "${ctx.question}"

Respond with a JSON object containing:
{
  "type": "select" | "ask" | "count",
  "patterns": [
    {
      "subject": "entity name or ?variable",
      "predicate": "relation type",
      "object": "entity name or ?variable"
    }
  ],
  "filters": [
    {
      "field": "variable.property",
      "operator": "eq" | "contains" | "gt" | "lt",
      "value": "the value"
    }
  ],
  "limit": number
}

Query JSON:`;
}

const GRAPH_QUERY_TYPES = new Set<GraphQuery['type']>(['select', 'ask', 'construct', 'describe']);
const QUERY_OPERATORS = new Set<QueryOperator>([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'regex',
  'in',
  'notIn',
]);

function toPatternPart(value: unknown): string | QueryVariable | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  return trimmed.startsWith('?') ? { name: trimmed.substring(1) } : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseNLQueryResponse(response: string): GraphQuery | null {
  try {
    const jsonStr = extractJSON(response);
    if (!jsonStr) return null;

    const parsed: unknown = JSON.parse(jsonStr);
    if (!isRecord(parsed)) return null;

    const rawType = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : 'select';
    const isCount = rawType === 'count';
    const type = GRAPH_QUERY_TYPES.has(rawType as GraphQuery['type'])
      ? (rawType as GraphQuery['type'])
      : 'select';

    const query: GraphQuery = { type, patterns: [] };

    if (Array.isArray(parsed.patterns)) {
      for (const p of parsed.patterns) {
        if (!isRecord(p)) continue;
        query.patterns.push({
          subject: toPatternPart(p.subject),
          predicate: toPatternPart(p.predicate),
          object: toPatternPart(p.object),
        });
      }
    }

    if (Array.isArray(parsed.filters)) {
      const filters = parsed.filters
        .filter(isRecord)
        .filter(
          (f) =>
            typeof f.field === 'string' &&
            typeof f.operator === 'string' &&
            QUERY_OPERATORS.has(f.operator as QueryOperator)
        )
        .map((f) => ({
          field: (f.field as string).replace(/^\?/, ''),
          operator: f.operator as QueryOperator,
          value: f.value,
        }));
      if (filters.length > 0) query.filters = filters;
    }

    if (typeof parsed.limit === 'number' && Number.isInteger(parsed.limit) && parsed.limit > 0) {
      query.limit = parsed.limit;
    }

    if (Array.isArray(parsed.orderBy)) {
      const orderBy = parsed.orderBy
        .filter(isRecord)
        .filter((o) => typeof o.field === 'string')
        .map((o) => ({
          field: (o.field as string).replace(/^\?/, ''),
          direction: o.direction === 'desc' ? ('desc' as const) : ('asc' as const),
        }));
      if (orderBy.length > 0) query.orderBy = orderBy;
    }

    if (isCount) {
      query.aggregates = [{ function: 'count', field: '*', alias: 'count' }];
    }

    return query;
  } catch {
    return null;
  }
}

export async function executeNLQuery(
  question: string,
  ctx: NLQueryContext
): Promise<NaturalLanguageQueryResult> {
  const analysis = analyzeNLQuery(question);
  const query = buildQueryFromAnalysis(analysis);

  const result = await executeQuery(query, {
    adapter: ctx.adapter,
    agentId: ctx.agentId,
    variables: new Map(),
  });

  const naturalLanguageResponse = formatResultAsNaturalLanguage(question, analysis, result);

  const confidence = calculateConfidence(analysis, result);

  return {
    query,
    results: result,
    naturalLanguageResponse,
    confidence,
  };
}

function formatResultAsNaturalLanguage(
  question: string,
  analysis: NLQueryAnalysis,
  result: GraphQueryResult
): string {
  if (analysis.intent === 'check') {
    return result.count > 0 ? 'Yes.' : 'No.';
  }

  if (result.count === 0) {
    return `I couldn't find any information to answer: "${question}"`;
  }

  if (analysis.intent === 'count') {
    const countValue = result.bindings[0]?.count;
    return `The count is ${countValue}.`;
  }

  const responses: string[] = [];

  for (const binding of result.bindings.slice(0, 5)) {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(binding)) {
      if (typeof value === 'object' && value !== null && 'name' in value) {
        parts.push(`${key}: ${(value as GraphNode).name}`);
      } else if (typeof value === 'object' && value !== null && 'type' in value) {
        const edge = value as GraphEdge;
        parts.push(`${key}: ${edge.label || edge.type}`);
      } else {
        parts.push(`${key}: ${value}`);
      }
    }

    responses.push(parts.join(', '));
  }

  if (result.count > 5) {
    responses.push(`... and ${result.count - 5} more results.`);
  }

  return responses.join('\n');
}

function calculateConfidence(analysis: NLQueryAnalysis, result: GraphQueryResult): number {
  let confidence = 0.5;

  if (analysis.entities.length > 0) {
    confidence += 0.2;
  }

  if (analysis.relations.length > 0) {
    confidence += 0.2;
  }

  if (result.count > 0) {
    confidence += 0.1;
  }

  if (result.count > 10) {
    confidence -= 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

export function suggestQuestions(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const suggestions: string[] = [];

  const entityTypes = new Set(nodes.map((n) => n.type));
  const relationTypes = new Set(edges.map((e) => e.type));

  for (const type of entityTypes) {
    suggestions.push(`What ${type}s are in the graph?`);
  }

  for (const relType of relationTypes) {
    const readable = relType.replace(/_/g, ' ');
    suggestions.push(`Which entities have a "${readable}" relationship?`);
  }

  if (nodes.length > 0) {
    const sampleNode = nodes[0];
    suggestions.push(`Tell me about ${sampleNode.name}`);
    suggestions.push(`What is connected to ${sampleNode.name}?`);
  }

  return suggestions.slice(0, 10);
}

export interface QueryClarification {
  type: 'ambiguous_entity' | 'missing_relation' | 'unclear_intent';
  message: string;
  options?: string[];
}

export function generateClarifications(
  analysis: NLQueryAnalysis,
  availableEntities: string[],
  availableRelations: string[]
): QueryClarification[] {
  const clarifications: QueryClarification[] = [];

  if (analysis.entities.length === 0 && analysis.variables.length === 0) {
    clarifications.push({
      type: 'ambiguous_entity',
      message: "I'm not sure what entity you're asking about. Could you specify?",
      options: availableEntities.slice(0, 5),
    });
  }

  if (analysis.relations.length === 0 && analysis.intent !== 'describe') {
    clarifications.push({
      type: 'missing_relation',
      message: 'What relationship are you interested in?',
      options: availableRelations.slice(0, 5),
    });
  }

  return clarifications;
}
