import { z } from 'zod';
import type {
  ToolContext,
  GraphAdapter,
  GraphNode,
  GraphEdge,
  EntityType,
  RelationType,
} from '@cogitator-ai/types';
import { tool } from '@cogitator-ai/core';
import type { NeuroSymbolic } from '../orchestrator';

export function createGraphTools(_ns: NeuroSymbolic, graphAdapter: GraphAdapter) {
  const findPath = tool({
    name: 'find_graph_path',
    description:
      'Find the shortest path between two nodes in the knowledge graph. ' +
      'Returns the path with intermediate nodes and edges.',
    category: 'database',
    tags: ['graph', 'pathfinding', 'knowledge-graph', 'neuro-symbolic'],
    parameters: z.object({
      startNode: z.string().describe('Start node ID or name'),
      endNode: z.string().describe('End node ID or name'),
      maxHops: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Maximum path length (default: 5)'),
    }),
    execute: async ({ startNode, endNode, maxHops }, context: ToolContext) => {
      const startNodeResult = await resolveNode(graphAdapter, context.agentId, startNode);
      if (!startNodeResult) {
        return { found: false, error: `Start node "${startNode}" not found` };
      }

      const endNodeResult = await resolveNode(graphAdapter, context.agentId, endNode);
      if (!endNodeResult) {
        return { found: false, error: `End node "${endNode}" not found` };
      }

      const pathResult = await graphAdapter.findShortestPath(
        context.agentId,
        startNodeResult.id,
        endNodeResult.id,
        maxHops ?? 5
      );

      if (!pathResult.success) {
        return { found: false, error: pathResult.error };
      }

      if (!pathResult.data) {
        return {
          found: false,
          message: `No path found between "${startNode}" and "${endNode}" within ${maxHops ?? 5} hops`,
        };
      }

      const path = pathResult.data;

      return {
        found: true,
        pathLength: path.length,
        totalWeight: path.totalWeight,
        nodes: path.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          type: n.type,
        })),
        edges: path.edges.map((e) => ({
          type: e.type,
          label: e.label,
          weight: e.weight,
        })),
        pathDescription: formatPath(path),
      };
    },
  });

  const queryGraph = tool({
    name: 'query_graph',
    description:
      'Query the knowledge graph to find nodes and their relationships. ' +
      'Filter by node type, name pattern, or edge types.',
    category: 'database',
    tags: ['graph', 'query', 'knowledge-graph', 'neuro-symbolic'],
    parameters: z.object({
      nodeTypes: z
        .array(
          z.enum(['person', 'organization', 'location', 'concept', 'event', 'object', 'custom'])
        )
        .optional()
        .describe('Filter by node types'),
      namePattern: z.string().max(200).optional().describe('Regex pattern to match node names'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default: 20)'),
      includeEdges: z.boolean().optional().describe('Include edges for each node (default: false)'),
    }),
    execute: async ({ nodeTypes, namePattern, limit, includeEdges }, context: ToolContext) => {
      const nodesResult = await graphAdapter.queryNodes({
        agentId: context.agentId,
        types: nodeTypes as EntityType[],
        namePattern,
        limit: limit ?? 20,
      });

      if (!nodesResult.success) {
        return { success: false, error: nodesResult.error };
      }

      const results: {
        id: string;
        name: string;
        type: string;
        description?: string;
        edges?: { direction: string; type: string; targetNode: string }[];
      }[] = [];

      for (const node of nodesResult.data) {
        const nodeInfo: (typeof results)[0] = {
          id: node.id,
          name: node.name,
          type: node.type,
          description: node.description,
        };

        if (includeEdges) {
          const neighborsResult = await graphAdapter.getNeighbors(node.id, 'both');
          if (neighborsResult.success) {
            nodeInfo.edges = neighborsResult.data.map(({ node: neighbor, edge }) => ({
              direction: edge.sourceNodeId === node.id ? 'outgoing' : 'incoming',
              type: edge.type,
              targetNode: neighbor.name,
            }));
          }
        }

        results.push(nodeInfo);
      }

      return {
        success: true,
        count: results.length,
        nodes: results,
      };
    },
  });

  const addGraphNode = tool({
    name: 'add_graph_node',
    description:
      'Add a new node (entity) to the knowledge graph. ' +
      'Nodes represent entities like people, organizations, concepts, etc.',
    category: 'database',
    tags: ['graph', 'write', 'knowledge-graph', 'neuro-symbolic'],
    parameters: z.object({
      name: z.string().describe('Node name'),
      type: z
        .enum(['person', 'organization', 'location', 'concept', 'event', 'object', 'custom'])
        .describe('Entity type'),
      description: z.string().optional().describe('Node description'),
      aliases: z.array(z.string()).optional().describe('Alternative names'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Additional properties'),
    }),
    sideEffects: ['database'],
    execute: async ({ name, type, description, aliases, properties }, context: ToolContext) => {
      const result = await graphAdapter.addNode({
        agentId: context.agentId,
        name,
        type: type as EntityType,
        description,
        aliases: aliases ?? [],
        properties: properties ?? {},
        confidence: 1.0,
        source: 'user',
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        nodeId: result.data.id,
        name: result.data.name,
        type: result.data.type,
      };
    },
  });

  const addGraphEdge = tool({
    name: 'add_graph_edge',
    description:
      'Add a relationship (edge) between two nodes in the knowledge graph. ' +
      'Edges represent relationships like "knows", "works_at", "part_of", etc.',
    category: 'database',
    tags: ['graph', 'write', 'knowledge-graph', 'neuro-symbolic'],
    parameters: z.object({
      sourceNode: z.string().describe('Source node ID or name'),
      targetNode: z.string().describe('Target node ID or name'),
      type: z
        .enum([
          'knows',
          'works_at',
          'located_in',
          'part_of',
          'related_to',
          'created_by',
          'belongs_to',
          'associated_with',
          'causes',
          'precedes',
          'custom',
        ])
        .describe('Relationship type'),
      label: z.string().optional().describe('Edge label/description'),
      weight: z.number().min(0).max(1).optional().describe('Edge weight (default: 1.0)'),
      bidirectional: z
        .boolean()
        .optional()
        .describe('Is relationship bidirectional (default: false)'),
    }),
    sideEffects: ['database'],
    execute: async (
      { sourceNode, targetNode, type, label, weight, bidirectional },
      context: ToolContext
    ) => {
      const sourceNodeResult = await resolveNode(graphAdapter, context.agentId, sourceNode);
      if (!sourceNodeResult) {
        return { success: false, error: `Source node "${sourceNode}" not found` };
      }

      const targetNodeResult = await resolveNode(graphAdapter, context.agentId, targetNode);
      if (!targetNodeResult) {
        return { success: false, error: `Target node "${targetNode}" not found` };
      }

      const result = await graphAdapter.addEdge({
        agentId: context.agentId,
        sourceNodeId: sourceNodeResult.id,
        targetNodeId: targetNodeResult.id,
        type: type as RelationType,
        label,
        weight: weight ?? 1.0,
        bidirectional: bidirectional ?? false,
        properties: {},
        confidence: 1.0,
        source: 'user',
      });

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return {
        success: true,
        edgeId: result.data.id,
        from: sourceNodeResult.name,
        to: targetNodeResult.name,
        type: result.data.type,
      };
    },
  });

  return { findPath, queryGraph, addGraphNode, addGraphEdge };
}

async function resolveNode(
  adapter: GraphAdapter,
  agentId: string,
  nodeIdOrName: string
): Promise<GraphNode | null> {
  const byIdResult = await adapter.getNode(nodeIdOrName);
  if (byIdResult.success && byIdResult.data) {
    return byIdResult.data;
  }

  const byNameResult = await adapter.getNodeByName(agentId, nodeIdOrName);
  if (byNameResult.success && byNameResult.data) {
    return byNameResult.data;
  }

  return null;
}

function formatPath(path: { nodes: GraphNode[]; edges: GraphEdge[] }): string {
  if (path.nodes.length === 0) return '';
  if (path.nodes.length === 1) return path.nodes[0].name;

  const parts: string[] = [];
  for (let i = 0; i < path.nodes.length - 1; i++) {
    const node = path.nodes[i];
    const edge = path.edges[i];
    if (!edge) break;
    parts.push(`${node.name} -[${edge.type}${edge.label ? `: ${edge.label}` : ''}]->`);
  }
  parts.push(path.nodes[path.nodes.length - 1].name);

  return parts.join(' ');
}
