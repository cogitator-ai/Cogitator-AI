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
    let current: unknown = item.properties;
    for (const segment of field.substring('properties.'.length).split('.')) {
      if (typeof current !== 'object' || current === null) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  return undefined;
}

interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
}

const TYPE_PREDICATES = new Set(['a', 'type', 'rdf:type']);

async function loadSnapshot(ctx: QueryExecutionContext): Promise<GraphSnapshot> {
  const [nodesResult, edgesResult] = await Promise.all([
    ctx.adapter.queryNodes({ agentId: ctx.agentId }),
    ctx.adapter.queryEdges({ agentId: ctx.agentId }),
  ]);

  if (!nodesResult.success) throw new Error(`Failed to load graph nodes: ${nodesResult.error}`);
  if (!edgesResult.success) throw new Error(`Failed to load graph edges: ${edgesResult.error}`);

  const nodeById = new Map(nodesResult.data.map((node) => [node.id, node]));
  return { nodes: nodesResult.data, edges: edgesResult.data, nodeById };
}

function nodeMatchesValue(node: GraphNode, value: string): boolean {
  return node.id === value || node.name === value || node.aliases.includes(value);
}

function bindNode(
  binding: QueryBinding,
  varName: string | null,
  value: string | null,
  node: GraphNode
): QueryBinding | null {
  if (value !== null) return nodeMatchesValue(node, value) ? binding : null;
  if (varName === null) return binding;

  const existing = binding[varName];
  if (existing !== undefined) {
    return typeof existing === 'object' && existing !== null && 'id' in existing
      ? (existing as GraphNode).id === node.id
        ? binding
        : null
      : null;
  }
  return { ...binding, [varName]: node };
}

function conditionsHold(
  conditions: QueryCondition[],
  subject: GraphNode,
  object: GraphNode | string,
  edge: GraphEdge | null
): boolean {
  for (const condition of conditions) {
    const scope = condition.field.split('.')[0];
    const fieldName = condition.field.replace(/^(subject|object|predicate)\./, '');
    const item = scope === 'subject' ? subject : scope === 'object' ? object : edge;

    const value =
      item === null
        ? undefined
        : typeof item === 'string'
          ? fieldName === 'type' || fieldName === 'object'
            ? item
            : undefined
          : getFieldValue(item, fieldName);

    if (!matchesCondition(value, condition)) return false;
  }
  return true;
}

function matchTypePattern(
  pattern: ParsedPattern,
  snapshot: GraphSnapshot,
  bindings: QueryBinding[]
): QueryBinding[] {
  const results: QueryBinding[] = [];

  for (const binding of bindings) {
    for (const node of snapshot.nodes) {
      const withSubject = bindNode(binding, pattern.subjectVar, pattern.subjectValue, node);
      if (!withSubject) continue;

      let withObject: QueryBinding = withSubject;
      if (pattern.objectValue !== null) {
        if (node.type.toLowerCase() !== pattern.objectValue.toLowerCase()) continue;
      } else if (pattern.objectVar !== null) {
        const existing = withSubject[pattern.objectVar];
        if (existing !== undefined && existing !== node.type) continue;
        withObject = { ...withSubject, [pattern.objectVar]: node.type };
      }

      if (conditionsHold(pattern.conditions, node, node.type, null)) {
        results.push(withObject);
      }
    }
  }

  return results;
}

function matchPattern(
  pattern: ParsedPattern,
  snapshot: GraphSnapshot,
  bindings: QueryBinding[],
  undirected: boolean
): QueryBinding[] {
  const results =
    pattern.predicateValue !== null && TYPE_PREDICATES.has(pattern.predicateValue)
      ? matchTypePattern(pattern, snapshot, bindings)
      : [];

  for (const binding of bindings) {
    for (const edge of snapshot.edges) {
      const source = snapshot.nodeById.get(edge.sourceNodeId);
      const target = snapshot.nodeById.get(edge.targetNodeId);
      if (!source || !target) continue;

      if (pattern.predicateValue !== null) {
        if (edge.type !== pattern.predicateValue && edge.label !== pattern.predicateValue) {
          continue;
        }
      }

      const orientations: [GraphNode, GraphNode][] = [[source, target]];
      if ((edge.bidirectional || undirected) && source.id !== target.id) {
        orientations.push([target, source]);
      }

      for (const [subject, object] of orientations) {
        let current = bindNode(binding, pattern.subjectVar, pattern.subjectValue, subject);
        if (!current) continue;

        if (pattern.predicateVar !== null) {
          const existing = current[pattern.predicateVar];
          if (existing !== undefined) {
            if ((existing as GraphEdge).id !== edge.id) continue;
          } else {
            current = { ...current, [pattern.predicateVar]: edge };
          }
        }

        current = bindNode(current, pattern.objectVar, pattern.objectValue, object);
        if (!current) continue;

        if (conditionsHold(pattern.conditions, subject, object, edge)) {
          results.push(current);
        }
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

      let comparison: number;
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
  if (fn === 'count' && field === '*') return bindings.length;

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

  if (query.patterns.length > 0) {
    const snapshot = await loadSnapshot(ctx);
    bindings = [{}];
    for (const pattern of query.patterns) {
      bindings = matchPattern(parsePattern(pattern), snapshot, bindings, query.type === 'describe');
      if (bindings.length === 0) break;
    }
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

const QUERY_KEYWORDS = new Set([
  'select',
  'ask',
  'construct',
  'describe',
  'where',
  'filter',
  'order',
  'limit',
  'offset',
]);

const FILTER_OPERATORS: Record<string, QueryOperator> = {
  '=': 'eq',
  '==': 'eq',
  eq: 'eq',
  '!=': 'neq',
  neq: 'neq',
  '>': 'gt',
  gt: 'gt',
  '>=': 'gte',
  gte: 'gte',
  '<': 'lt',
  lt: 'lt',
  '<=': 'lte',
  lte: 'lte',
  contains: 'contains',
  startswith: 'startsWith',
  endswith: 'endsWith',
  regex: 'regex',
  in: 'in',
  notin: 'notIn',
};

const QUERY_TOKEN =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[{}()[\],]|!=|>=|<=|==|[<>=]|[^\s{}()[\],<>=!"']+/g;

function tokenizeQuery(input: string): string[] {
  return input.match(QUERY_TOKEN) ?? [];
}

function isQuoted(token: string): boolean {
  if (token.length < 2) return false;
  const quote = token[0];
  return (quote === '"' || quote === "'") && token.endsWith(quote);
}

function unquote(token: string): string {
  return token.slice(1, -1).replace(/\\(.)/g, '$1');
}

function parseLiteral(token: string): unknown {
  if (isQuoted(token)) return unquote(token);
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  const num = Number(token);
  if (token !== '' && Number.isFinite(num)) return num;
  return token;
}

function parseTriplePart(token: string): string | QueryVariable {
  if (token.startsWith('?')) return { name: token.substring(1) };
  if (isQuoted(token)) return unquote(token);
  return token;
}

function fieldReference(token: string): string {
  return token.startsWith('?') ? token.substring(1) : token;
}

export function parseQueryString(queryString: string): GraphQuery {
  const tokens = tokenizeQuery(queryString.trim());
  const query: GraphQuery = { type: 'select', patterns: [] };
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const isKeyword = (token: string | undefined): boolean =>
    token !== undefined && !isQuoted(token) && QUERY_KEYWORDS.has(token.toLowerCase());

  const parseWhere = (): void => {
    let triple: string[] = [];
    const flush = (): void => {
      if (triple.length === 3) {
        query.patterns.push({
          subject: parseTriplePart(triple[0]),
          predicate: parseTriplePart(triple[1]),
          object: parseTriplePart(triple[2]),
        });
      }
      triple = [];
    };

    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token === '{') {
        pos++;
        continue;
      }
      if (token === '}') {
        pos++;
        break;
      }
      if (isKeyword(token)) {
        if (token.toLowerCase() === 'filter') {
          flush();
          pos++;
          parseFilter();
          continue;
        }
        break;
      }
      pos++;

      if (token === '.' || token === ',') {
        flush();
        continue;
      }

      const endsTriple = token.length > 1 && token.endsWith('.') && !isQuoted(token);
      triple.push(endsTriple ? token.slice(0, -1) : token);
      if (endsTriple || triple.length === 3) flush();
    }
    flush();
  };

  const parseFilter = (): void => {
    let depth = 0;
    const expression: string[] = [];
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token === '(') {
        depth++;
        pos++;
        continue;
      }
      if (token === ')') {
        depth--;
        pos++;
        if (depth <= 0) break;
        continue;
      }
      if (depth === 0 && (isKeyword(token) || token === '}')) break;
      expression.push(token);
      pos++;
      if (depth === 0 && expression.length >= 3 && (expression[2] !== '[' || token === ']')) {
        break;
      }
    }

    if (expression.length < 3) return;
    const operator = FILTER_OPERATORS[expression[1].toLowerCase()];
    if (!operator) return;

    const rawValue = expression.slice(2);
    const value =
      rawValue[0] === '['
        ? rawValue.filter((t) => t !== '[' && t !== ']' && t !== ',').map(parseLiteral)
        : parseLiteral(rawValue[0]);

    query.filters ??= [];
    query.filters.push({ field: fieldReference(expression[0]), operator, value });
  };

  const parseOrderBy = (): void => {
    if (peek()?.toLowerCase() === 'by') pos++;
    while (pos < tokens.length && !isKeyword(peek())) {
      let token = tokens[pos++];
      if (token === ',') continue;

      let direction: 'asc' | 'desc' = 'asc';
      const lower = token.toLowerCase();
      if ((lower === 'asc' || lower === 'desc') && peek() === '(') {
        direction = lower;
        pos++;
        token = tokens[pos++] ?? '';
        if (peek() === ')') pos++;
      } else if (peek()?.toLowerCase() === 'desc' || peek()?.toLowerCase() === 'asc') {
        direction = tokens[pos++].toLowerCase() as 'asc' | 'desc';
      }

      if (token) {
        query.orderBy ??= [];
        query.orderBy.push({ field: fieldReference(token), direction });
      }
    }
  };

  const parseCount = (): number | undefined => {
    const value = Number(tokens[pos]);
    if (Number.isInteger(value) && value >= 0) {
      pos++;
      return value;
    }
    return undefined;
  };

  while (pos < tokens.length) {
    const token = tokens[pos++];
    switch (token.toLowerCase()) {
      case 'select':
      case 'ask':
      case 'construct':
      case 'describe':
        query.type = token.toLowerCase() as GraphQuery['type'];
        while (pos < tokens.length && !isKeyword(peek()) && peek() !== '{') pos++;
        break;
      case 'where':
        parseWhere();
        break;
      case 'filter':
        parseFilter();
        break;
      case 'order':
        parseOrderBy();
        break;
      case 'limit':
        query.limit = parseCount() ?? query.limit;
        break;
      case 'offset':
        query.offset = parseCount() ?? query.offset;
        break;
      case '{':
        pos--;
        parseWhere();
        break;
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
