import type {
  GraphAdapter,
  GraphNode,
  GraphEdge,
  NodeQuery,
  EdgeQuery,
  TraversalOptions,
  TraversalResult,
  GraphPath,
  GraphSemanticSearchOptions,
  GraphStats,
  TraversalDirection,
  EntityType,
  RelationType,
  MemoryResult,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export class MemoryGraphAdapter implements GraphAdapter {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();
  private nodesByAgent = new Map<string, Set<string>>();
  private edgesBySource = new Map<string, Set<string>>();
  private edgesByTarget = new Map<string, Set<string>>();

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    const id = nanoid();
    const now = new Date();

    const newNode: GraphNode = {
      ...node,
      id,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };

    this.nodes.set(id, newNode);

    if (!this.nodesByAgent.has(node.agentId)) {
      this.nodesByAgent.set(node.agentId, new Set());
    }
    this.nodesByAgent.get(node.agentId)!.add(id);

    return { success: true, data: newNode };
  }

  async getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>> {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.lastAccessedAt = new Date();
      node.accessCount++;
    }
    return { success: true, data: node ?? null };
  }

  async getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    const agentNodes = this.nodesByAgent.get(agentId);
    if (!agentNodes) {
      return { success: true, data: null };
    }

    for (const nodeId of agentNodes) {
      const node = this.nodes.get(nodeId);
      if (node && (node.name === name || node.aliases.includes(name))) {
        node.lastAccessedAt = new Date();
        node.accessCount++;
        return { success: true, data: node };
      }
    }

    return { success: true, data: null };
  }

  async updateNode(
    nodeId: string,
    updates: Partial<
      Pick<
        GraphNode,
        'name' | 'aliases' | 'description' | 'properties' | 'confidence' | 'metadata' | 'embedding'
      >
    >
  ): Promise<MemoryResult<GraphNode>> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return { success: false, error: `Node ${nodeId} not found` };
    }

    const updatedNode: GraphNode = {
      ...node,
      ...updates,
      updatedAt: new Date(),
    };

    this.nodes.set(nodeId, updatedNode);
    return { success: true, data: updatedNode };
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return { success: false, error: `Node ${nodeId} not found` };
    }

    const sourceEdges = this.edgesBySource.get(nodeId) ?? new Set();
    const targetEdges = this.edgesByTarget.get(nodeId) ?? new Set();

    for (const edgeId of [...sourceEdges, ...targetEdges]) {
      await this.deleteEdge(edgeId);
    }

    this.nodes.delete(nodeId);
    this.nodesByAgent.get(node.agentId)?.delete(nodeId);

    return { success: true, data: undefined };
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    const results: GraphNode[] = [];
    const agentNodes = this.nodesByAgent.get(query.agentId);

    if (!agentNodes) {
      return { success: true, data: [] };
    }

    for (const nodeId of agentNodes) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;

      if (query.types && !query.types.includes(node.type)) continue;
      if (query.minConfidence && node.confidence < query.minConfidence) continue;
      if (query.namePattern) {
        const pattern = new RegExp(query.namePattern, 'i');
        if (!pattern.test(node.name) && !node.aliases.some((a) => pattern.test(a))) {
          continue;
        }
      }

      const resultNode = query.includeEmbedding ? node : { ...node, embedding: undefined };
      results.push(resultNode);

      if (query.limit && results.length >= query.limit) break;
    }

    return { success: true, data: results };
  }

  async searchNodesSemantic(
    options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    if (!options.vector) {
      return { success: true, data: [] };
    }

    const nodesResult = await this.queryNodes({
      agentId: options.agentId,
      types: options.entityTypes,
      includeEmbedding: true,
    });

    if (!nodesResult.success) {
      return { success: false, error: nodesResult.error };
    }

    const scored = nodesResult.data
      .filter((n) => n.embedding?.length === options.vector!.length)
      .map((node) => ({
        ...node,
        score: cosineSimilarity(node.embedding!, options.vector!),
      }))
      .filter((n) => !options.threshold || n.score >= options.threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 10);

    return { success: true, data: scored };
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    const id = nanoid();
    const now = new Date();

    const newEdge: GraphEdge = {
      ...edge,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.edges.set(id, newEdge);

    if (!this.edgesBySource.has(edge.sourceNodeId)) {
      this.edgesBySource.set(edge.sourceNodeId, new Set());
    }
    this.edgesBySource.get(edge.sourceNodeId)!.add(id);

    if (!this.edgesByTarget.has(edge.targetNodeId)) {
      this.edgesByTarget.set(edge.targetNodeId, new Set());
    }
    this.edgesByTarget.get(edge.targetNodeId)!.add(id);

    return { success: true, data: newEdge };
  }

  async getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>> {
    return { success: true, data: this.edges.get(edgeId) ?? null };
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    const sourceEdges = this.edgesBySource.get(sourceNodeId) ?? new Set();
    const results: GraphEdge[] = [];

    for (const edgeId of sourceEdges) {
      const edge = this.edges.get(edgeId);
      if (edge?.targetNodeId === targetNodeId) {
        results.push(edge);
      }
    }

    return { success: true, data: results };
  }

  async updateEdge(
    edgeId: string,
    updates: Partial<
      Pick<
        GraphEdge,
        'weight' | 'label' | 'properties' | 'confidence' | 'validFrom' | 'validUntil' | 'metadata'
      >
    >
  ): Promise<MemoryResult<GraphEdge>> {
    const edge = this.edges.get(edgeId);
    if (!edge) {
      return { success: false, error: `Edge ${edgeId} not found` };
    }

    const updatedEdge: GraphEdge = {
      ...edge,
      ...updates,
      updatedAt: new Date(),
    };

    this.edges.set(edgeId, updatedEdge);
    return { success: true, data: updatedEdge };
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    const edge = this.edges.get(edgeId);
    if (!edge) {
      return { success: false, error: `Edge ${edgeId} not found` };
    }

    this.edges.delete(edgeId);
    this.edgesBySource.get(edge.sourceNodeId)?.delete(edgeId);
    this.edgesByTarget.get(edge.targetNodeId)?.delete(edgeId);

    return { success: true, data: undefined };
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    const results: GraphEdge[] = [];

    for (const edge of this.edges.values()) {
      if (edge.agentId !== query.agentId) continue;
      if (query.sourceNodeId && edge.sourceNodeId !== query.sourceNodeId) continue;
      if (query.targetNodeId && edge.targetNodeId !== query.targetNodeId) continue;
      if (query.types && !query.types.includes(edge.type)) continue;
      if (query.minWeight && edge.weight < query.minWeight) continue;
      if (query.minConfidence && edge.confidence < query.minConfidence) continue;
      if (query.bidirectionalOnly && !edge.bidirectional) continue;

      results.push(edge);
      if (query.limit && results.length >= query.limit) break;
    }

    return { success: true, data: results };
  }

  async traverse(options: TraversalOptions): Promise<MemoryResult<TraversalResult>> {
    const visitedNodes = new Map<string, GraphNode>();
    const visitedEdges = new Map<string, GraphEdge>();
    const paths: GraphPath[] = [];

    const startNodeResult = await this.getNode(options.startNodeId);
    if (!startNodeResult.success || !startNodeResult.data) {
      return { success: false, error: 'Start node not found' };
    }

    const queue: { nodeId: string; path: GraphPath; depth: number }[] = [
      {
        nodeId: options.startNodeId,
        path: {
          nodes: [startNodeResult.data],
          edges: [],
          totalWeight: 0,
          length: 0,
        },
        depth: 0,
      },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= options.maxDepth) {
        paths.push(current.path);
        continue;
      }

      const neighbors = await this.getNeighbors(current.nodeId, options.direction);
      if (!neighbors.success) continue;

      let hasChildren = false;
      for (const { node, edge } of neighbors.data) {
        if (visitedNodes.has(node.id)) continue;
        if (options.edgeTypes && !options.edgeTypes.includes(edge.type)) continue;
        if (options.minEdgeWeight && edge.weight < options.minEdgeWeight) continue;
        if (options.minConfidence && edge.confidence < options.minConfidence) continue;

        visitedNodes.set(node.id, node);
        visitedEdges.set(edge.id, edge);
        hasChildren = true;

        queue.push({
          nodeId: node.id,
          path: {
            nodes: [...current.path.nodes, node],
            edges: [...current.path.edges, edge],
            totalWeight: current.path.totalWeight + edge.weight,
            length: current.path.length + 1,
          },
          depth: current.depth + 1,
        });

        if (options.limit && paths.length >= options.limit) break;
      }

      if (!hasChildren) {
        paths.push(current.path);
      }
    }

    return {
      success: true,
      data: {
        paths,
        visitedNodes: Array.from(visitedNodes.values()),
        visitedEdges: Array.from(visitedEdges.values()),
        depth: options.maxDepth,
      },
    };
  }

  async findShortestPath(
    _agentId: string,
    startNodeId: string,
    endNodeId: string,
    maxDepth = 10
  ): Promise<MemoryResult<GraphPath | null>> {
    const visited = new Set<string>();
    const queue: { nodeId: string; path: GraphPath }[] = [];

    const startNodeResult = await this.getNode(startNodeId);
    if (!startNodeResult.success || !startNodeResult.data) {
      return { success: false, error: 'Start node not found' };
    }

    queue.push({
      nodeId: startNodeId,
      path: {
        nodes: [startNodeResult.data],
        edges: [],
        totalWeight: 0,
        length: 0,
      },
    });

    visited.add(startNodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.nodeId === endNodeId) {
        return { success: true, data: current.path };
      }

      if (current.path.length >= maxDepth) continue;

      const neighbors = await this.getNeighbors(current.nodeId, 'both');
      if (!neighbors.success) continue;

      for (const { node, edge } of neighbors.data) {
        if (visited.has(node.id)) continue;

        visited.add(node.id);
        queue.push({
          nodeId: node.id,
          path: {
            nodes: [...current.path.nodes, node],
            edges: [...current.path.edges, edge],
            totalWeight: current.path.totalWeight + edge.weight,
            length: current.path.length + 1,
          },
        });
      }
    }

    return { success: true, data: null };
  }

  async getNeighbors(
    nodeId: string,
    direction: TraversalDirection = 'both'
  ): Promise<MemoryResult<{ node: GraphNode; edge: GraphEdge }[]>> {
    const results: { node: GraphNode; edge: GraphEdge }[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outEdges = this.edgesBySource.get(nodeId) ?? new Set();
      for (const edgeId of outEdges) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          const node = this.nodes.get(edge.targetNodeId);
          if (node) {
            results.push({ node, edge });
          }
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const inEdges = this.edgesByTarget.get(nodeId) ?? new Set();
      for (const edgeId of inEdges) {
        const edge = this.edges.get(edgeId);
        if (edge) {
          const node = this.nodes.get(edge.sourceNodeId);
          if (node) {
            results.push({ node, edge });
          }
        }
      }
    }

    return { success: true, data: results };
  }

  async mergeNodes(
    targetNodeId: string,
    sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    const targetNode = this.nodes.get(targetNodeId);
    if (!targetNode) {
      return { success: false, error: `Target node ${targetNodeId} not found` };
    }

    const allAliases = new Set(targetNode.aliases);
    const allProperties = { ...targetNode.properties };

    for (const sourceId of sourceNodeIds) {
      const sourceNode = this.nodes.get(sourceId);
      if (!sourceNode) continue;

      allAliases.add(sourceNode.name);
      sourceNode.aliases.forEach((a) => allAliases.add(a));
      Object.assign(allProperties, sourceNode.properties);

      const sourceEdges = this.edgesBySource.get(sourceId) ?? new Set();
      for (const edgeId of sourceEdges) {
        const edge = this.edges.get(edgeId);
        if (edge && edge.targetNodeId !== targetNodeId) {
          await this.addEdge({
            ...edge,
            sourceNodeId: targetNodeId,
          });
        }
      }

      const targetEdges = this.edgesByTarget.get(sourceId) ?? new Set();
      for (const edgeId of targetEdges) {
        const edge = this.edges.get(edgeId);
        if (edge && edge.sourceNodeId !== targetNodeId) {
          await this.addEdge({
            ...edge,
            targetNodeId: targetNodeId,
          });
        }
      }

      await this.deleteNode(sourceId);
    }

    const updatedNode: GraphNode = {
      ...targetNode,
      aliases: Array.from(allAliases),
      properties: allProperties,
      updatedAt: new Date(),
    };

    this.nodes.set(targetNodeId, updatedNode);
    return { success: true, data: updatedNode };
  }

  async clearGraph(agentId: string): Promise<MemoryResult<void>> {
    const agentNodes = this.nodesByAgent.get(agentId);
    if (agentNodes) {
      for (const nodeId of [...agentNodes]) {
        await this.deleteNode(nodeId);
      }
    }
    return { success: true, data: undefined };
  }

  async getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>> {
    const nodesByType: Record<EntityType, number> = {
      person: 0,
      organization: 0,
      location: 0,
      concept: 0,
      event: 0,
      object: 0,
      custom: 0,
    };

    const edgesByType: Record<RelationType, number> = {
      knows: 0,
      works_at: 0,
      located_in: 0,
      part_of: 0,
      related_to: 0,
      created_by: 0,
      belongs_to: 0,
      associated_with: 0,
      causes: 0,
      precedes: 0,
      custom: 0,
    };

    let nodeCount = 0;
    let edgeCount = 0;

    const agentNodes = this.nodesByAgent.get(agentId) ?? new Set();
    for (const nodeId of agentNodes) {
      const node = this.nodes.get(nodeId);
      if (node) {
        nodeCount++;
        nodesByType[node.type]++;
      }
    }

    for (const edge of this.edges.values()) {
      if (edge.agentId === agentId) {
        edgeCount++;
        edgesByType[edge.type]++;
      }
    }

    return {
      success: true,
      data: {
        nodeCount,
        edgeCount,
        nodesByType,
        edgesByType,
        averageEdgesPerNode: nodeCount > 0 ? edgeCount / nodeCount : 0,
        maxDepth: 0,
      },
    };
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

export function createMemoryGraphAdapter(): MemoryGraphAdapter {
  return new MemoryGraphAdapter();
}
