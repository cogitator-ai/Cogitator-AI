import type {
  GraphQuery,
  GraphQueryResult,
  QueryPattern,
  QueryCondition,
  QueryBinding,
  QueryVariable,
  QueryOperator,
  AggregateFunction,
  GraphNode,
  GraphEdge,
  GraphAdapter,
} from '@cogitator-ai/types';

export interface QueryExecutionContext {
  adapter: GraphAdapter;
  agentId: string;
  variables: Map<string, unknown>;
  timeout?: number;
}

export interface ParsedPattern {
  subjectVar: string | null;
  subjectValue: string | null;
  predicateVar: string | null;
  predicateValue: string | null;
  objectVar: string | null;
  objectValue: string | null;
  conditions: QueryCondition[];
}

function parsePattern(pattern: QueryPattern): ParsedPattern {
  const getVarOrValue = (
    item: string | QueryVariable | undefined
  ): { var: string | null; value: string | null } => {
    if (!item) return { var: null, value: null };
    if (typeof item === 'string') return { var: null, value: item };
    return { var: item.name, value: null };
  };

  const subject = getVarOrValue(pattern.subject);
  const predicate = getVarOrValue(pattern.predicate);
  const object = getVarOrValue(pattern.object);

  return {
    subjectVar: subject.var,
    subjectValue: subject.value,
    predicateVar: predicate.var,
    predicateValue: predicate.value,
    objectVar: object.var,
    objectValue: object.value,
    conditions: pattern.conditions || [],
  };
}

function matchesCondition(value: unknown, condition: QueryCondition): boolean {
  const target = condition.value;

  switch (condition.operator) {
    case 'eq':
      return value === target;
    case 'neq':
      return value !== target;
    case 'gt':
      return typeof value === 'number' && typeof target === 'number' && value > target;
    case 'gte':
      return typeof value === 'number' && typeof target === 'number' && value >= target;
    case 'lt':
      return typeof value === 'number' && typeof target === 'number' && value < target;
    case 'lte':
      return typeof value === 'number' && typeof target === 'number' && value <= target;
    case 'contains':
      return typeof value === 'string' && typeof target === 'string' && value.includes(target);
    case 'startsWith':
      return typeof value === 'string' && typeof target === 'string' && value.startsWith(target);
    case 'endsWith':
      return typeof value === 'string' && typeof target === 'string' && value.endsWith(target);
    case 'regex': {
      if (typeof value !== 'string' || typeof target !== 'string' || target.length > 200)
        return false;
      try {
        return new RegExp(target).test(value);
      } catch {
        return false;
      }
    }
    case 'in':
      return Array.isArray(target) && target.includes(value);
    case 'notIn':
      return Array.isArray(target) && !target.includes(value);
    default:
      return false;
  }
}

function getFieldValue(item: GraphNode | GraphEdge, field: string): unknown {
  if (field === 'id') return item.id;
  if (field === 'type') return item.type;
  if (field === 'confidence') return item.confidence;
  if (field === 'source') return item.source;

  if ('name' in item) {
    const node = item as GraphNode;
    if (field === 'name') return node.name;
    if (field === 'description') return node.description;
    if (field === 'aliases') return node.aliases;
  }

  if ('weight' in item) {
    const edge = item as GraphEdge;
    if (field === 'weight') return edge.weight;
    if (field === 'label') return edge.label;
    if (field === 'sourceNodeId') return edge.sourceNodeId;
    if (field === 'targetNodeId') return edge.targetNodeId;
  }

  if (field.startsWith('properties.') && 'properties' in item) {
    const propPath = field.substring(11);
    return item.properties?.[propPath];
  }

  return undefined;
}

async function matchPattern(
  pattern: ParsedPattern,
  ctx: QueryExecutionContext,
  existingBindings: QueryBinding[]
): Promise<QueryBinding[]> {
  const results: QueryBinding[] = [];
  const { adapter, agentId } = ctx;

  const nodesResult = await adapter.queryNodes({
    agentId,
    limit: 1000,
  });

  if (!nodesResult.success || !nodesResult.data) {
    return [];
  }

  const nodes = nodesResult.data;
  const nodeMap = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const edgesResult = await adapter.queryEdges({
    agentId,
    limit: 1000,
  });

  if (!edgesResult.success || !edgesResult.data) {
    return [];
  }

  const edges = edgesResult.data;

  const startBindings = existingBindings.length > 0 ? existingBindings : [{}];

  for (const binding of startBindings) {
    for (const edge of edges) {
      const sourceNode = nodeMap.get(edge.sourceNodeId);
      const targetNode = nodeMap.get(edge.targetNodeId);

      if (!sourceNode || !targetNode) continue;

      const newBinding: QueryBinding = { ...binding };
      let matches = true;

      if (pattern.subjectValue) {
        if (sourceNode.name !== pattern.subjectValue && sourceNode.id !== pattern.subjectValue) {
          matches = false;
        }
      } else if (pattern.subjectVar) {
        const existingValue = binding[pattern.subjectVar];
        if (existingValue) {
          if ((existingValue as GraphNode).id !== sourceNode.id) {
            matches = false;
          }
        } else {
          newBinding[pattern.subjectVar] = sourceNode;
        }
      }

      if (matches && pattern.predicateValue) {
        if (edge.type !== pattern.predicateValue && edge.label !== pattern.predicateValue) {
          matches = false;
        }
      } else if (matches && pattern.predicateVar) {
        const existingValue = binding[pattern.predicateVar];
        if (existingValue) {
          if ((existingValue as GraphEdge).id !== edge.id) {
            matches = false;
          }
        } else {
          newBinding[pattern.predicateVar] = edge;
        }
      }

      if (matches && pattern.objectValue) {
        if (targetNode.name !== pattern.objectValue && targetNode.id !== pattern.objectValue) {
          matches = false;
        }
      } else if (matches && pattern.objectVar) {
        const existingValue = binding[pattern.objectVar];
        if (existingValue) {
          if ((existingValue as GraphNode).id !== targetNode.id) {
            matches = false;
          }
        } else {
          newBinding[pattern.objectVar] = targetNode;
        }
      }

      if (matches) {
        for (const condition of pattern.conditions) {
          const item = condition.field.startsWith('subject')
            ? sourceNode
            : condition.field.startsWith('object')
              ? targetNode
              : edge;

          const fieldName = condition.field.replace(/^(subject|object|predicate)\./, '');
          const value = getFieldValue(item, fieldName);

          if (!matchesCondition(value, condition)) {
            matches = false;
            break;
          }
        }
      }

      if (matches) {
        results.push(newBinding);
      }
    }
  }

  return results;
}

function applyFilters(bindings: QueryBinding[], filters: QueryCondition[]): QueryBinding[] {
  return bindings.filter((binding) => {
    for (const filter of filters) {
      const varName = filter.field.split('.')[0];
      const fieldPath = filter.field.substring(varName.length + 1);

      const boundValue = binding[varName];
      if (!boundValue) return false;

      let value: unknown;
      if (typeof boundValue === 'object' && boundValue !== null) {
        value = getFieldValue(boundValue as GraphNode | GraphEdge, fieldPath || 'name');
      } else {
        value = boundValue;
      }

      if (!matchesCondition(value, filter)) {
        return false;
      }
    }
    return true;
  });
}

function applyOrdering(
  bindings: QueryBinding[],
  orderBy: { field: string; direction: 'asc' | 'desc' }[]
): QueryBinding[] {
  return [...bindings].sort((a, b) => {
    for (const order of orderBy) {
      const varName = order.field.split('.')[0];
      const fieldPath = order.field.substring(varName.length + 1);

      const aValue = a[varName];
      const bValue = b[varName];

      let aField: unknown;
      let bField: unknown;

      if (typeof aValue === 'object' && aValue !== null) {
        aField = getFieldValue(aValue as GraphNode | GraphEdge, fieldPath || 'name');
      } else {
        aField = aValue;
      }

      if (typeof bValue === 'object' && bValue !== null) {
        bField = getFieldValue(bValue as GraphNode | GraphEdge, fieldPath || 'name');
      } else {
        bField = bValue;
      }

      let comparison = 0;
      if (aField === bField) {
        comparison = 0;
      } else if (aField === undefined || aField === null) {
        comparison = 1;
      } else if (bField === undefined || bField === null) {
        comparison = -1;
      } else if (typeof aField === 'number' && typeof bField === 'number') {
        comparison = aField - bField;
      } else {
        comparison = String(aField).localeCompare(String(bField));
      }

      if (comparison !== 0) {
        return order.direction === 'desc' ? -comparison : comparison;
      }
    }
    return 0;
  });
}

function applyAggregates(
  bindings: QueryBinding[],
  aggregates: { function: AggregateFunction; field: string; alias: string }[],
  groupBy?: string[]
): QueryBinding[] {
  if (groupBy && groupBy.length > 0) {
    const groups = new Map<string, QueryBinding[]>();

    for (const binding of bindings) {
      const key = groupBy
        .map((field) => {
          const value = binding[field];
          if (typeof value === 'object' && value !== null && 'id' in value) {
            return (value as { id: string }).id;
          }
          return String(value);
        })
        .join('|');

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(binding);
    }

    const results: QueryBinding[] = [];

    for (const [, groupBindings] of groups) {
      const result: QueryBinding = {};

      for (const field of groupBy) {
        result[field] = groupBindings[0][field];
      }

      for (const agg of aggregates) {
        result[agg.alias] = computeAggregate(groupBindings, agg.function, agg.field);
      }

      results.push(result);
    }

    return results;
  }

  if (aggregates.length > 0 && bindings.length > 0) {
    const result: QueryBinding = {};

    for (const agg of aggregates) {
      result[agg.alias] = computeAggregate(bindings, agg.function, agg.field);
    }

    return [result];
  }

  return bindings;
}

function computeAggregate(bindings: QueryBinding[], fn: AggregateFunction, field: string): unknown {
  const varName = field.split('.')[0];
  const fieldPath = field.substring(varName.length + 1);

  const values: number[] = [];

  for (const binding of bindings) {
    const boundValue = binding[varName];

    if (fn === 'count' && boundValue !== undefined) {
      values.push(1);
      continue;
    }

    let value: unknown;
    if (typeof boundValue === 'object' && boundValue !== null) {
      value = getFieldValue(boundValue as GraphNode | GraphEdge, fieldPath || 'confidence');
    } else {
      value = boundValue;
    }

    if (typeof value === 'number') {
      values.push(value);
    }
  }

  switch (fn) {
    case 'count':
      return values.length;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case 'min':
      return values.length > 0 ? Math.min(...values) : null;
    case 'max':
      return values.length > 0 ? Math.max(...values) : null;
    default:
      return null;
  }
}

export async function executeQuery(
  query: GraphQuery,
  ctx: QueryExecutionContext
): Promise<GraphQueryResult> {
  const startTime = Date.now();

  let bindings: QueryBinding[] = [];

  for (const pattern of query.patterns) {
    const parsed = parsePattern(pattern);
    bindings = await matchPattern(parsed, ctx, bindings);
  }

  if (query.filters && query.filters.length > 0) {
    bindings = applyFilters(bindings, query.filters);
  }

  if (query.orderBy && query.orderBy.length > 0) {
    bindings = applyOrdering(bindings, query.orderBy);
  }

  if (query.aggregates && query.aggregates.length > 0) {
    bindings = applyAggregates(bindings, query.aggregates, query.groupBy);
  }

  if (query.offset && query.offset > 0) {
    bindings = bindings.slice(query.offset);
  }

  if (query.limit && query.limit > 0) {
    bindings = bindings.slice(0, query.limit);
  }

  const executionTime = Date.now() - startTime;

  return {
    bindings,
    count: bindings.length,
    executionTime,
  };
}

export class GraphQueryBuilder {
  private query: GraphQuery;

  constructor(type: GraphQuery['type'] = 'select') {
    this.query = {
      type,
      patterns: [],
    };
  }

  static select(): GraphQueryBuilder {
    return new GraphQueryBuilder('select');
  }

  static ask(): GraphQueryBuilder {
    return new GraphQueryBuilder('ask');
  }

  static construct(): GraphQueryBuilder {
    return new GraphQueryBuilder('construct');
  }

  static describe(): GraphQueryBuilder {
    return new GraphQueryBuilder('describe');
  }

  where(
    subject: string | QueryVariable,
    predicate: string | QueryVariable,
    object: string | QueryVariable
  ): this {
    this.query.patterns.push({ subject, predicate, object });
    return this;
  }

  pattern(pattern: QueryPattern): this {
    this.query.patterns.push(pattern);
    return this;
  }

  filter(field: string, operator: QueryOperator, value: unknown): this {
    if (!this.query.filters) {
      this.query.filters = [];
    }
    this.query.filters.push({ field, operator, value });
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    if (!this.query.orderBy) {
      this.query.orderBy = [];
    }
    this.query.orderBy.push({ field, direction });
    return this;
  }

  limit(n: number): this {
    this.query.limit = n;
    return this;
  }

  offset(n: number): this {
    this.query.offset = n;
    return this;
  }

  count(field: string, alias: string): this {
    if (!this.query.aggregates) {
      this.query.aggregates = [];
    }
    this.query.aggregates.push({ function: 'count', field, alias });
    return this;
  }

  sum(field: string, alias: string): this {
    if (!this.query.aggregates) {
      this.query.aggregates = [];
    }
    this.query.aggregates.push({ function: 'sum', field, alias });
    return this;
  }

  avg(field: string, alias: string): this {
    if (!this.query.aggregates) {
      this.query.aggregates = [];
    }
    this.query.aggregates.push({ function: 'avg', field, alias });
    return this;
  }

  min(field: string, alias: string): this {
    if (!this.query.aggregates) {
      this.query.aggregates = [];
    }
    this.query.aggregates.push({ function: 'min', field, alias });
    return this;
  }

  max(field: string, alias: string): this {
    if (!this.query.aggregates) {
      this.query.aggregates = [];
    }
    this.query.aggregates.push({ function: 'max', field, alias });
    return this;
  }

  groupBy(...fields: string[]): this {
    this.query.groupBy = fields;
    return this;
  }

  build(): GraphQuery {
    return { ...this.query };
  }

  async execute(ctx: QueryExecutionContext): Promise<GraphQueryResult> {
    return executeQuery(this.build(), ctx);
  }
}

export function variable(name: string, type?: 'node' | 'edge' | 'value'): QueryVariable {
  return { name, type };
}

export function parseQueryString(queryString: string): GraphQuery {
  const lines = queryString
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const query: GraphQuery = { type: 'select', patterns: [] };

  let currentSection: 'select' | 'where' | 'filter' | 'order' | 'limit' | null = null;

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.startsWith('select')) {
      query.type = 'select';
      currentSection = 'select';
    } else if (lower.startsWith('ask')) {
      query.type = 'ask';
      currentSection = 'select';
    } else if (lower.startsWith('construct')) {
      query.type = 'construct';
      currentSection = 'select';
    } else if (lower.startsWith('describe')) {
      query.type = 'describe';
      currentSection = 'select';
    } else if (lower.startsWith('where')) {
      currentSection = 'where';
    } else if (lower.startsWith('filter')) {
      currentSection = 'filter';
    } else if (lower.startsWith('order by')) {
      currentSection = 'order';
    } else if (lower.startsWith('limit')) {
      const match = /limit\s+(\d+)/i.exec(line);
      if (match) {
        query.limit = parseInt(match[1], 10);
      }
    } else if (lower.startsWith('offset')) {
      const match = /offset\s+(\d+)/i.exec(line);
      if (match) {
        query.offset = parseInt(match[1], 10);
      }
    } else if (currentSection === 'where') {
      const tripleMatch = /(\?\s*\w+|"[^"]+"|[\w]+)\s+(\w+)\s+(\?\s*\w+|"[^"]+"|[\w]+)/.exec(line);
      if (tripleMatch) {
        const subjStr = tripleMatch[1];
        const predicate = tripleMatch[2];
        const objStr = tripleMatch[3];

        const parseTriplePart = (s: string): string | QueryVariable => {
          if (s.startsWith('?')) return { name: s.substring(1).trim() };
          if (s.startsWith('"')) return s.slice(1, -1);
          return s;
        };

        const subject = parseTriplePart(subjStr);
        const object = parseTriplePart(objStr);

        query.patterns.push({ subject, predicate, object });
      }
    }
  }

  return query;
}

export function formatQueryResult(result: GraphQueryResult): string {
  const lines: string[] = [];

  lines.push(`Query completed in ${result.executionTime}ms`);
  lines.push(`Found ${result.count} result(s)`);
  lines.push('');

  if (result.bindings.length === 0) {
    lines.push('No results.');
    return lines.join('\n');
  }

  const allKeys = new Set<string>();
  for (const binding of result.bindings) {
    for (const key of Object.keys(binding)) {
      allKeys.add(key);
    }
  }

  const keys = Array.from(allKeys);
  lines.push(keys.join('\t|\t'));
  lines.push('-'.repeat(keys.length * 16));

  for (const binding of result.bindings) {
    const row: string[] = [];
    for (const key of keys) {
      const value = binding[key];
      if (value === undefined || value === null) {
        row.push('-');
      } else if (typeof value === 'object' && 'name' in value) {
        row.push((value as GraphNode).name);
      } else if (typeof value === 'object' && 'label' in value) {
        row.push((value as GraphEdge).label || (value as GraphEdge).type);
      } else {
        row.push(String(value));
      }
    }
    lines.push(row.join('\t|\t'));
  }

  return lines.join('\n');
}
