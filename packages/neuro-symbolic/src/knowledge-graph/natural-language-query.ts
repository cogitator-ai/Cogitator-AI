import type {
  GraphQuery,
  GraphQueryResult,
  NaturalLanguageQueryResult,
  GraphAdapter,
  GraphNode,
  GraphEdge,
  EntityType,
  RelationType,
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

export function analyzeNLQuery(question: string): NLQueryAnalysis {
  const lower = question.toLowerCase();
  const analysis: NLQueryAnalysis = {
    intent: 'find',
    entities: [],
    relations: [],
    constraints: [],
    variables: [],
  };

  if (
    lower.startsWith('is ') ||
    lower.startsWith('are ') ||
    lower.startsWith('does ') ||
    lower.startsWith('do ')
  ) {
    analysis.intent = 'check';
  } else if (lower.startsWith('how many') || lower.includes('count')) {
    analysis.intent = 'count';
  } else if (
    lower.startsWith('what is') ||
    lower.startsWith('describe') ||
    lower.startsWith('tell me about')
  ) {
    analysis.intent = 'describe';
  } else if (lower.includes('compare') || lower.includes('difference between')) {
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

  const relationKeywords = [
    'works at',
    'works for',
    'employed by',
    'knows',
    'friends with',
    'related to',
    'located in',
    'lives in',
    'based in',
    'part of',
    'belongs to',
    'member of',
    'created by',
    'made by',
    'built by',
    'connected to',
    'linked to',
    'associated with',
  ];

  for (const keyword of relationKeywords) {
    if (lower.includes(keyword)) {
      analysis.relations.push(keyword.replace(/\s+/g, '_'));
    }
  }

  if (lower.includes('who')) {
    analysis.variables.push('person');
  }
  if (lower.includes('what')) {
    analysis.variables.push('thing');
  }
  if (lower.includes('where')) {
    analysis.variables.push('location');
  }
  if (lower.includes('when')) {
    analysis.variables.push('time');
  }

  return analysis;
}

export function buildQueryFromAnalysis(analysis: NLQueryAnalysis): GraphQuery {
  const builder =
    analysis.intent === 'check' ? GraphQueryBuilder.ask() : GraphQueryBuilder.select();

  if (analysis.intent === 'count') {
    builder.count('X', 'count');
  }

  if (analysis.entities.length >= 2 && analysis.relations.length > 0) {
    builder.where(analysis.entities[0], analysis.relations[0], analysis.entities[1]);
  } else if (analysis.entities.length === 1 && analysis.relations.length > 0) {
    builder.where(variable('X'), analysis.relations[0], analysis.entities[0]);
  } else if (analysis.entities.length === 1) {
    builder.where(variable('X'), variable('relation'), analysis.entities[0]);
    builder.where(analysis.entities[0], variable('relation2'), variable('Y'));
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

export function parseNLQueryResponse(response: string): GraphQuery | null {
  try {
    const jsonStr = extractJSON(response);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    const query: GraphQuery = {
      type: parsed.type || 'select',
      patterns: [],
    };

    if (Array.isArray(parsed.patterns)) {
      for (const p of parsed.patterns) {
        query.patterns.push({
          subject: p.subject?.startsWith('?') ? { name: p.subject.substring(1) } : p.subject,
          predicate: p.predicate?.startsWith('?')
            ? { name: p.predicate.substring(1) }
            : p.predicate,
          object: p.object?.startsWith('?') ? { name: p.object.substring(1) } : p.object,
        });
      }
    }

    if (Array.isArray(parsed.filters)) {
      query.filters = parsed.filters;
    }

    if (parsed.limit) {
      query.limit = parsed.limit;
    }

    if (parsed.orderBy) {
      query.orderBy = parsed.orderBy;
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
    suggestions.push(`Who ${relType.replace(/_/g, ' ')} whom?`);
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
  _question: string,
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
