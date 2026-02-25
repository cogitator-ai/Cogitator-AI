import type {
  GraphNode,
  GraphEdge,
  GraphPath,
  GraphQuery,
  GraphQueryResult,
  EntityType,
  RelationType,
} from '@cogitator-ai/types';
import { extractJSON } from './utils';

export interface GraphContextForPrompt {
  nodes: GraphNode[];
  edges: GraphEdge[];
  question?: string;
}

export function createGraphContextPrompt(ctx: GraphContextForPrompt): string {
  const nodeDescriptions = ctx.nodes
    .map((n) => `- ${n.name} (${n.type}): ${n.description || 'No description'}`)
    .join('\n');

  const edgeDescriptions = ctx.edges
    .map((e) => {
      const sourceNode = ctx.nodes.find((n) => n.id === e.sourceNodeId);
      const targetNode = ctx.nodes.find((n) => n.id === e.targetNodeId);
      return `- ${sourceNode?.name || e.sourceNodeId} --[${e.label || e.type}]--> ${targetNode?.name || e.targetNodeId}`;
    })
    .join('\n');

  return `Knowledge Graph Context:

Entities:
${nodeDescriptions || 'No entities.'}

Relationships:
${edgeDescriptions || 'No relationships.'}

${ctx.question ? `\nQuestion: ${ctx.question}` : ''}`;
}

export interface QueryToNLContext {
  query: GraphQuery;
  result: GraphQueryResult;
}

export function createQueryExplanationPrompt(ctx: QueryToNLContext): string {
  const patterns = ctx.query.patterns
    .map((p) => {
      const subj = typeof p.subject === 'string' ? p.subject : `?${p.subject?.name}`;
      const pred = typeof p.predicate === 'string' ? p.predicate : `?${p.predicate?.name}`;
      const obj = typeof p.object === 'string' ? p.object : `?${p.object?.name}`;
      return `  (${subj}, ${pred}, ${obj})`;
    })
    .join('\n');

  return `Explain the following graph query results in natural language.

Query type: ${ctx.query.type}
Patterns:
${patterns}

Number of results: ${ctx.result.count}
Execution time: ${ctx.result.executionTime}ms

Provide a clear, concise explanation of what was queried and what was found.`;
}

export interface PathExplanationContext {
  path: GraphPath;
  question?: string;
}

export function createPathExplanationPrompt(ctx: PathExplanationContext): string {
  const steps: string[] = [];

  for (let i = 0; i < ctx.path.edges.length; i++) {
    const edge = ctx.path.edges[i];
    const fromNode = ctx.path.nodes[i];
    const toNode = ctx.path.nodes[i + 1];

    steps.push(`${i + 1}. ${fromNode.name} --[${edge.label || edge.type}]--> ${toNode.name}`);
  }

  return `Explain the following path through a knowledge graph:

Path (${ctx.path.length} steps):
${steps.join('\n')}

Total weight: ${ctx.path.totalWeight.toFixed(3)}

${ctx.question ? `Original question: ${ctx.question}` : ''}

Provide a natural language explanation of how these entities are connected.`;
}

export interface EntityExtractionContext {
  text: string;
  existingTypes?: EntityType[];
  existingRelations?: RelationType[];
}

export function createEntityExtractionPrompt(ctx: EntityExtractionContext): string {
  const typesList = ctx.existingTypes?.length
    ? `Available entity types: ${ctx.existingTypes.join(', ')}`
    : 'Entity types: person, organization, location, concept, event, object';

  const relationsList = ctx.existingRelations?.length
    ? `Available relation types: ${ctx.existingRelations.join(', ')}`
    : 'Relation types: knows, works_at, located_in, part_of, related_to, created_by, belongs_to, associated_with';

  return `Extract entities and relationships from the following text.

${typesList}
${relationsList}

Text:
"${ctx.text}"

Respond with a JSON object:
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "entity_type",
      "description": "Brief description",
      "confidence": 0.0-1.0
    }
  ],
  "relations": [
    {
      "source": "Source Entity Name",
      "target": "Target Entity Name",
      "type": "relation_type",
      "confidence": 0.0-1.0
    }
  ]
}

JSON:`;
}

export interface ReasoningExplanationContext {
  startNode: string;
  endNode: string;
  paths: GraphPath[];
  question?: string;
}

export function createReasoningExplanationPrompt(ctx: ReasoningExplanationContext): string {
  const pathDescriptions = ctx.paths
    .map((path, i) => {
      const steps = [];
      for (let j = 0; j < path.edges.length; j++) {
        const edge = path.edges[j];
        const fromNode = path.nodes[j];
        const toNode = path.nodes[j + 1];
        steps.push(`${fromNode.name} --[${edge.label || edge.type}]--> ${toNode.name}`);
      }
      return `Path ${i + 1} (confidence: ${(path.totalWeight * 100).toFixed(1)}%):\n  ${steps.join(' → ')}`;
    })
    .join('\n\n');

  return `Explain the reasoning paths between two entities in the knowledge graph.

From: ${ctx.startNode}
To: ${ctx.endNode}

${ctx.paths.length > 0 ? `Found ${ctx.paths.length} path(s):\n\n${pathDescriptions}` : 'No paths found.'}

${ctx.question ? `Question: ${ctx.question}` : ''}

Explain how these entities are connected and what the relationships mean.`;
}

export interface GraphSummaryContext {
  nodeCount: number;
  edgeCount: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  topNodes: GraphNode[];
}

export function createGraphSummaryPrompt(ctx: GraphSummaryContext): string {
  const nodeTypeSummary = Object.entries(ctx.nodesByType)
    .map(([type, count]) => `  - ${type}: ${count}`)
    .join('\n');

  const edgeTypeSummary = Object.entries(ctx.edgesByType)
    .map(([type, count]) => `  - ${type}: ${count}`)
    .join('\n');

  const topNodesSummary = ctx.topNodes.map((n) => `  - ${n.name} (${n.type})`).join('\n');

  return `Summarize the following knowledge graph in natural language.

Statistics:
- Total entities: ${ctx.nodeCount}
- Total relationships: ${ctx.edgeCount}

Entities by type:
${nodeTypeSummary}

Relationships by type:
${edgeTypeSummary}

Most connected entities:
${topNodesSummary}

Provide a concise summary of what this knowledge graph contains.`;
}

export function parseEntityExtractionResponse(response: string): {
  entities: Array<{
    name: string;
    type: EntityType;
    description?: string;
    confidence: number;
  }>;
  relations: Array<{
    source: string;
    target: string;
    type: RelationType;
    confidence: number;
  }>;
} | null {
  try {
    const jsonStr = extractJSON(response);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    return {
      entities: (parsed.entities || []).map((e: Record<string, unknown>) => ({
        name: String(e.name || ''),
        type: (e.type as EntityType) || 'custom',
        description: e.description ? String(e.description) : undefined,
        confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      })),
      relations: (parsed.relations || []).map((r: Record<string, unknown>) => ({
        source: String(r.source || ''),
        target: String(r.target || ''),
        type: (r.type as RelationType) || 'related_to',
        confidence: typeof r.confidence === 'number' ? r.confidence : 0.5,
      })),
    };
  } catch {
    return null;
  }
}

export function formatNodeForPrompt(node: GraphNode): string {
  const props = Object.entries(node.properties)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  return `${node.name} (${node.type})${node.description ? `: ${node.description}` : ''}${props ? ` [${props}]` : ''}`;
}

export function formatEdgeForPrompt(
  edge: GraphEdge,
  sourceNode?: GraphNode,
  targetNode?: GraphNode
): string {
  const source = sourceNode?.name || edge.sourceNodeId;
  const target = targetNode?.name || edge.targetNodeId;
  const label = edge.label || edge.type;

  return `${source} --[${label}]--> ${target}`;
}

export function formatPathForPrompt(path: GraphPath): string {
  const steps: string[] = [];

  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    const fromNode = path.nodes[i];
    const toNode = path.nodes[i + 1];

    if (i === 0) {
      steps.push(fromNode.name);
    }
    steps.push(`--[${edge.label || edge.type}]-->`);
    steps.push(toNode.name);
  }

  return steps.join(' ');
}
