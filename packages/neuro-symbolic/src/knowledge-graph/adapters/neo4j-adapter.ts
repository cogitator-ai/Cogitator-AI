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
import { cosineSimilarity } from '../utils';

export interface Neo4jGraphAdapterConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
  vectorDimensions?: number;
}

type Neo4jDriver = {
  session(config?: { database?: string }): Neo4jSession;
  close(): Promise<void>;
};

type Neo4jTransaction = {
  run(query: string, params?: Record<string, unknown>): Promise<Neo4jResult>;
};

type Neo4jSession = {
  run(query: string, params?: Record<string, unknown>): Promise<Neo4jResult>;
  executeWrite<T>(work: (tx: Neo4jTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

type Neo4jResult = {
  records: Neo4jRecord[];
};

type Neo4jRecord = {
  get(key: string): unknown;
  toObject(): Record<string, unknown>;
};

type Neo4jNode = {
  properties: Record<string, unknown>;
};

type Neo4jRelationship = {
  properties: Record<string, unknown>;
};

export class Neo4jGraphAdapter implements GraphAdapter {
  private driver: Neo4jDriver | null = null;
  private config: Neo4jGraphAdapterConfig;
  private database: string;

  constructor(config: Neo4jGraphAdapterConfig) {
    this.config = config;
    this.database = config.database ?? 'neo4j';
  }

  async connect(): Promise<MemoryResult<void>> {
    try {
      const neo4j = await import('neo4j-driver');
      const driver = neo4j.default ?? neo4j;

      this.driver = driver.driver(
        this.config.uri,
        driver.auth.basic(this.config.username, this.config.password)
      ) as Neo4jDriver;

      const session = this.driver.session({ database: this.database });
      await session.run('RETURN 1');
      await session.close();

      await this.initConstraints();

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: `Neo4j connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async initConstraints(): Promise<void> {
    if (!this.driver) return;

    const session = this.driver.session({ database: this.database });
    try {
      await session.run(`
        CREATE CONSTRAINT graph_node_id IF NOT EXISTS
        FOR (n:GraphNode) REQUIRE n.id IS UNIQUE
      `);
    } catch {}

    try {
      await session.run(`
        CREATE INDEX graph_node_agent IF NOT EXISTS
        FOR (n:GraphNode) ON (n.agentId)
      `);
    } catch {}

    try {
      await session.run(`
        CREATE INDEX graph_node_type IF NOT EXISTS
        FOR (n:GraphNode) ON (n.agentId, n.type)
      `);
    } catch {}

    await session.close();
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
    return { success: true, data: undefined };
  }

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const id = nanoid();
      const now = new Date().toISOString();

      const result = await session.run(
        `CREATE (n:GraphNode {
          id: $id,
          agentId: $agentId,
          type: $type,
          name: $name,
          aliases: $aliases,
          description: $description,
          properties: $properties,
          embedding: $embedding,
          confidence: $confidence,
          source: $source,
          metadata: $metadata,
          createdAt: datetime($createdAt),
          updatedAt: datetime($updatedAt),
          lastAccessedAt: datetime($lastAccessedAt),
          accessCount: 0
        })
        RETURN n`,
        {
          id,
          agentId: node.agentId,
          type: node.type,
          name: node.name,
          aliases: node.aliases,
          description: node.description ?? null,
          properties: JSON.stringify(node.properties),
          embedding: node.embedding ?? null,
          confidence: node.confidence,
          source: node.source,
          metadata: JSON.stringify(node.metadata ?? {}),
          createdAt: now,
          updatedAt: now,
          lastAccessedAt: now,
        }
      );

      const createdNode = this.recordToNode(result.records[0].get('n') as Neo4jNode);
      return { success: true, data: createdNode };
    } finally {
      await session.close();
    }
  }

  async getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (n:GraphNode {id: $nodeId})
         SET n.lastAccessedAt = datetime(), n.accessCount = n.accessCount + 1
         RETURN n`,
        { nodeId }
      );

      if (result.records.length === 0) return { success: true, data: null };

      return { success: true, data: this.recordToNode(result.records[0].get('n') as Neo4jNode) };
    } finally {
      await session.close();
    }
  }

  async getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (n:GraphNode {agentId: $agentId})
         WHERE n.name = $name OR $name IN n.aliases
         SET n.lastAccessedAt = datetime(), n.accessCount = n.accessCount + 1
         RETURN n
         LIMIT 1`,
        { agentId, name }
      );

      if (result.records.length === 0) return { success: true, data: null };

      return { success: true, data: this.recordToNode(result.records[0].get('n') as Neo4jNode) };
    } finally {
      await session.close();
    }
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
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const setClauses: string[] = ['n.updatedAt = datetime()'];
      const params: Record<string, unknown> = { nodeId };

      if (updates.name !== undefined) {
        setClauses.push('n.name = $name');
        params.name = updates.name;
      }
      if (updates.aliases !== undefined) {
        setClauses.push('n.aliases = $aliases');
        params.aliases = updates.aliases;
      }
      if (updates.description !== undefined) {
        setClauses.push('n.description = $description');
        params.description = updates.description;
      }
      if (updates.properties !== undefined) {
        setClauses.push('n.properties = $properties');
        params.properties = JSON.stringify(updates.properties);
      }
      if (updates.confidence !== undefined) {
        setClauses.push('n.confidence = $confidence');
        params.confidence = updates.confidence;
      }
      if (updates.metadata !== undefined) {
        setClauses.push('n.metadata = $metadata');
        params.metadata = JSON.stringify(updates.metadata);
      }
      if (updates.embedding !== undefined) {
        setClauses.push('n.embedding = $embedding');
        params.embedding = updates.embedding;
      }

      const result = await session.run(
        `MATCH (n:GraphNode {id: $nodeId})
         SET ${setClauses.join(', ')}
         RETURN n`,
        params
      );

      if (result.records.length === 0) {
        return { success: false, error: `Node ${nodeId} not found` };
      }

      return { success: true, data: this.recordToNode(result.records[0].get('n') as Neo4jNode) };
    } finally {
      await session.close();
    }
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (n:GraphNode {id: $nodeId})
         DETACH DELETE n
         RETURN count(n) as deleted`,
        { nodeId }
      );

      const deleted = result.records[0].get('deleted') as number;
      if (deleted === 0) {
        return { success: false, error: `Node ${nodeId} not found` };
      }

      return { success: true, data: undefined };
    } finally {
      await session.close();
    }
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const whereClauses: string[] = ['n.agentId = $agentId'];
      const params: Record<string, unknown> = { agentId: query.agentId };

      if (query.types && query.types.length > 0) {
        whereClauses.push('n.type IN $types');
        params.types = query.types;
      }
      if (query.minConfidence !== undefined) {
        whereClauses.push('n.confidence >= $minConfidence');
        params.minConfidence = query.minConfidence;
      }
      if (query.namePattern) {
        whereClauses.push(
          '(n.name =~ $namePattern OR any(a IN n.aliases WHERE a =~ $namePattern))'
        );
        params.namePattern = `(?i)${query.namePattern}`;
      }

      let cypher = `MATCH (n:GraphNode) WHERE ${whereClauses.join(' AND ')} RETURN n`;
      if (query.limit) {
        cypher += ` LIMIT $queryLimit`;
        params.queryLimit = query.limit;
      }

      const result = await session.run(cypher, params);

      const nodes = result.records.map((record) => {
        const node = this.recordToNode(record.get('n') as Neo4jNode);
        if (!query.includeEmbedding) {
          node.embedding = undefined;
        }
        return node;
      });

      return { success: true, data: nodes };
    } finally {
      await session.close();
    }
  }

  async searchNodesSemantic(
    options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    if (!this.driver) return { success: false, error: 'Not connected' };
    if (!options.vector) return { success: true, data: [] };

    const session = this.driver.session({ database: this.database });
    try {
      const whereClauses: string[] = ['n.agentId = $agentId', 'n.embedding IS NOT NULL'];
      const params: Record<string, unknown> = {
        agentId: options.agentId,
        queryVector: options.vector,
        threshold: options.threshold ?? 0.7,
      };

      if (options.entityTypes && options.entityTypes.length > 0) {
        whereClauses.push('n.type IN $types');
        params.types = options.entityTypes;
      }

      params.queryLimit = options.limit ?? 10;

      const result = await session.run(
        `MATCH (n:GraphNode)
         WHERE ${whereClauses.join(' AND ')}
         WITH n, gds.similarity.cosine(n.embedding, $queryVector) AS score
         WHERE score >= $threshold
         RETURN n, score
         ORDER BY score DESC
         LIMIT $queryLimit`,
        params
      );

      const nodes = result.records.map((record) => ({
        ...this.recordToNode(record.get('n') as Neo4jNode),
        score: record.get('score') as number,
      }));

      return { success: true, data: nodes };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('gds') ||
          error.message.includes('Unknown function') ||
          error.message.includes('similarity.cosine'))
      ) {
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
      throw error;
    } finally {
      await session.close();
    }
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const id = nanoid();
      const now = new Date().toISOString();

      const result = await session.run(
        `MATCH (s:GraphNode {id: $sourceNodeId}), (t:GraphNode {id: $targetNodeId})
         CREATE (s)-[r:RELATION {
           id: $id,
           agentId: $agentId,
           type: $type,
           label: $label,
           weight: $weight,
           bidirectional: $bidirectional,
           properties: $properties,
           confidence: $confidence,
           source: $source,
           validFrom: $validFrom,
           validUntil: $validUntil,
           metadata: $metadata,
           createdAt: datetime($createdAt),
           updatedAt: datetime($updatedAt)
         }]->(t)
         RETURN r, s.id as sourceId, t.id as targetId`,
        {
          id,
          agentId: edge.agentId,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          type: edge.type,
          label: edge.label ?? null,
          weight: edge.weight,
          bidirectional: edge.bidirectional,
          properties: JSON.stringify(edge.properties),
          confidence: edge.confidence,
          source: edge.source,
          validFrom: edge.validFrom?.toISOString() ?? null,
          validUntil: edge.validUntil?.toISOString() ?? null,
          metadata: JSON.stringify(edge.metadata ?? {}),
          createdAt: now,
          updatedAt: now,
        }
      );

      const createdEdge = this.recordToEdge(
        result.records[0].get('r') as Neo4jRelationship,
        edge.sourceNodeId,
        edge.targetNodeId
      );
      return { success: true, data: createdEdge };
    } finally {
      await session.close();
    }
  }

  async getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (s:GraphNode)-[r:RELATION {id: $edgeId}]->(t:GraphNode)
         RETURN r, s.id as sourceId, t.id as targetId`,
        { edgeId }
      );

      if (result.records.length === 0) return { success: true, data: null };

      const record = result.records[0];
      return {
        success: true,
        data: this.recordToEdge(
          record.get('r') as Neo4jRelationship,
          record.get('sourceId') as string,
          record.get('targetId') as string
        ),
      };
    } finally {
      await session.close();
    }
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (s:GraphNode {id: $sourceNodeId})-[r:RELATION]->(t:GraphNode {id: $targetNodeId})
         RETURN r, s.id as sourceId, t.id as targetId`,
        { sourceNodeId, targetNodeId }
      );

      const edges = result.records.map((record) =>
        this.recordToEdge(
          record.get('r') as Neo4jRelationship,
          record.get('sourceId') as string,
          record.get('targetId') as string
        )
      );

      return { success: true, data: edges };
    } finally {
      await session.close();
    }
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
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const setClauses: string[] = ['r.updatedAt = datetime()'];
      const params: Record<string, unknown> = { edgeId };

      if (updates.weight !== undefined) {
        setClauses.push('r.weight = $weight');
        params.weight = updates.weight;
      }
      if (updates.label !== undefined) {
        setClauses.push('r.label = $label');
        params.label = updates.label;
      }
      if (updates.properties !== undefined) {
        setClauses.push('r.properties = $properties');
        params.properties = JSON.stringify(updates.properties);
      }
      if (updates.confidence !== undefined) {
        setClauses.push('r.confidence = $confidence');
        params.confidence = updates.confidence;
      }
      if (updates.validFrom !== undefined) {
        setClauses.push('r.validFrom = $validFrom');
        params.validFrom = updates.validFrom?.toISOString() ?? null;
      }
      if (updates.validUntil !== undefined) {
        setClauses.push('r.validUntil = $validUntil');
        params.validUntil = updates.validUntil?.toISOString() ?? null;
      }
      if (updates.metadata !== undefined) {
        setClauses.push('r.metadata = $metadata');
        params.metadata = JSON.stringify(updates.metadata);
      }

      const result = await session.run(
        `MATCH (s:GraphNode)-[r:RELATION {id: $edgeId}]->(t:GraphNode)
         SET ${setClauses.join(', ')}
         RETURN r, s.id as sourceId, t.id as targetId`,
        params
      );

      if (result.records.length === 0) {
        return { success: false, error: `Edge ${edgeId} not found` };
      }

      const record = result.records[0];
      return {
        success: true,
        data: this.recordToEdge(
          record.get('r') as Neo4jRelationship,
          record.get('sourceId') as string,
          record.get('targetId') as string
        ),
      };
    } finally {
      await session.close();
    }
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH ()-[r:RELATION {id: $edgeId}]->()
         DELETE r
         RETURN count(r) as deleted`,
        { edgeId }
      );

      const deleted = result.records[0].get('deleted') as number;
      if (deleted === 0) {
        return { success: false, error: `Edge ${edgeId} not found` };
      }

      return { success: true, data: undefined };
    } finally {
      await session.close();
    }
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const whereClauses: string[] = ['r.agentId = $agentId'];
      const params: Record<string, unknown> = { agentId: query.agentId };

      let matchClause = '(s:GraphNode)-[r:RELATION]->(t:GraphNode)';

      if (query.sourceNodeId) {
        matchClause = '(s:GraphNode {id: $sourceNodeId})-[r:RELATION]->(t:GraphNode)';
        params.sourceNodeId = query.sourceNodeId;
      }
      if (query.targetNodeId) {
        if (query.sourceNodeId) {
          matchClause =
            '(s:GraphNode {id: $sourceNodeId})-[r:RELATION]->(t:GraphNode {id: $targetNodeId})';
        } else {
          matchClause = '(s:GraphNode)-[r:RELATION]->(t:GraphNode {id: $targetNodeId})';
        }
        params.targetNodeId = query.targetNodeId;
      }

      if (query.types && query.types.length > 0) {
        whereClauses.push('r.type IN $types');
        params.types = query.types;
      }
      if (query.minWeight !== undefined) {
        whereClauses.push('r.weight >= $minWeight');
        params.minWeight = query.minWeight;
      }
      if (query.minConfidence !== undefined) {
        whereClauses.push('r.confidence >= $minConfidence');
        params.minConfidence = query.minConfidence;
      }
      if (query.bidirectionalOnly) {
        whereClauses.push('r.bidirectional = true');
      }

      let cypher = `MATCH ${matchClause} WHERE ${whereClauses.join(' AND ')} RETURN r, s.id as sourceId, t.id as targetId`;
      if (query.limit) {
        cypher += ` LIMIT $queryLimit`;
        params.queryLimit = query.limit;
      }

      const result = await session.run(cypher, params);

      const edges = result.records.map((record) =>
        this.recordToEdge(
          record.get('r') as Neo4jRelationship,
          record.get('sourceId') as string,
          record.get('targetId') as string
        )
      );

      return { success: true, data: edges };
    } finally {
      await session.close();
    }
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

    visitedNodes.set(options.startNodeId, startNodeResult.data);

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
    if (!this.driver) return { success: false, error: 'Not connected' };

    const safeDepth = Math.max(1, Math.min(20, Math.floor(Number(maxDepth) || 3)));

    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (start:GraphNode {id: $startNodeId}), (end:GraphNode {id: $endNodeId}),
               path = shortestPath((start)-[*..${safeDepth}]-(end))
         RETURN path`,
        { startNodeId, endNodeId }
      );

      if (result.records.length === 0) {
        return { success: true, data: null };
      }

      const pathRecord = result.records[0].get('path') as {
        segments: Array<{
          start: Neo4jNode;
          relationship: Neo4jRelationship;
          end: Neo4jNode;
        }>;
      };

      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      let totalWeight = 0;

      if (pathRecord.segments.length > 0) {
        nodes.push(this.recordToNode(pathRecord.segments[0].start));
      }

      for (const segment of pathRecord.segments) {
        const node = this.recordToNode(segment.end);
        const edge = this.recordToEdge(
          segment.relationship,
          segment.start.properties.id as string,
          segment.end.properties.id as string
        );
        nodes.push(node);
        edges.push(edge);
        totalWeight += edge.weight;
      }

      return {
        success: true,
        data: {
          nodes,
          edges,
          totalWeight,
          length: edges.length,
        },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('gds') ||
          error.message.includes('apoc') ||
          error.message.includes('Unknown function') ||
          error.message.includes('shortestPath'))
      ) {
        return this.findShortestPathBFS(startNodeId, endNodeId, maxDepth);
      }
      throw error;
    } finally {
      await session.close();
    }
  }

  private async findShortestPathBFS(
    startNodeId: string,
    endNodeId: string,
    maxDepth: number
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
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      const results: { node: GraphNode; edge: GraphEdge }[] = [];

      if (direction === 'outgoing' || direction === 'both') {
        const outResult = await session.run(
          `MATCH (s:GraphNode {id: $nodeId})-[r:RELATION]->(t:GraphNode)
           RETURN r, t, s.id as sourceId, t.id as targetId`,
          { nodeId }
        );

        for (const record of outResult.records) {
          results.push({
            node: this.recordToNode(record.get('t') as Neo4jNode),
            edge: this.recordToEdge(
              record.get('r') as Neo4jRelationship,
              record.get('sourceId') as string,
              record.get('targetId') as string
            ),
          });
        }
      }

      if (direction === 'incoming' || direction === 'both') {
        const inResult = await session.run(
          `MATCH (s:GraphNode)-[r:RELATION]->(t:GraphNode {id: $nodeId})
           RETURN r, s, s.id as sourceId, t.id as targetId`,
          { nodeId }
        );

        for (const record of inResult.records) {
          results.push({
            node: this.recordToNode(record.get('s') as Neo4jNode),
            edge: this.recordToEdge(
              record.get('r') as Neo4jRelationship,
              record.get('sourceId') as string,
              record.get('targetId') as string
            ),
          });
        }
      }

      return { success: true, data: results };
    } finally {
      await session.close();
    }
  }

  async mergeNodes(
    targetNodeId: string,
    sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const targetNodeResult = await this.getNode(targetNodeId);
    if (!targetNodeResult.success || !targetNodeResult.data) {
      return { success: false, error: `Target node ${targetNodeId} not found` };
    }

    const targetNode = targetNodeResult.data;
    const allAliases = new Set(targetNode.aliases);
    const allProperties = { ...targetNode.properties };

    for (const sourceId of sourceNodeIds) {
      const sourceNodeResult = await this.getNode(sourceId);
      if (!sourceNodeResult.success || !sourceNodeResult.data) continue;

      const sourceNode = sourceNodeResult.data;
      allAliases.add(sourceNode.name);
      sourceNode.aliases.forEach((a) => allAliases.add(a));
      Object.assign(allProperties, sourceNode.properties);
    }

    const session = this.driver.session({ database: this.database });
    try {
      await session.executeWrite(async (tx) => {
        for (const sourceId of sourceNodeIds) {
          await tx.run(
            `MATCH (s:GraphNode {id: $sourceId})-[r:RELATION]->(t:GraphNode)
             WHERE t.id <> $targetId
             MATCH (target:GraphNode {id: $targetId})
             CREATE (target)-[r2:RELATION]->(t)
             SET r2 = properties(r)
             DELETE r`,
            { sourceId, targetId: targetNodeId }
          );

          await tx.run(
            `MATCH (s:GraphNode)-[r:RELATION]->(source:GraphNode {id: $sourceId})
             WHERE s.id <> $targetId
             MATCH (target:GraphNode {id: $targetId})
             CREATE (s)-[r2:RELATION]->(target)
             SET r2 = properties(r)
             DELETE r`,
            { sourceId, targetId: targetNodeId }
          );

          await tx.run(`MATCH (n:GraphNode {id: $sourceId}) DETACH DELETE n`, { sourceId });
        }
      });

      return this.updateNode(targetNodeId, {
        aliases: Array.from(allAliases),
        properties: allProperties,
      });
    } finally {
      await session.close();
    }
  }

  async clearGraph(agentId: string): Promise<MemoryResult<void>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

    const session = this.driver.session({ database: this.database });
    try {
      await session.run(
        `MATCH (n:GraphNode {agentId: $agentId})
         DETACH DELETE n`,
        { agentId }
      );

      return { success: true, data: undefined };
    } finally {
      await session.close();
    }
  }

  async getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>> {
    if (!this.driver) return { success: false, error: 'Not connected' };

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

    const session = this.driver.session({ database: this.database });
    try {
      const nodeResult = await session.run(
        `MATCH (n:GraphNode {agentId: $agentId})
         RETURN n.type as type, count(n) as count`,
        { agentId }
      );

      let nodeCount = 0;
      for (const record of nodeResult.records) {
        const type = record.get('type') as EntityType;
        const count = (record.get('count') as { low: number }).low;
        if (type in nodesByType) {
          nodesByType[type] = count;
        }
        nodeCount += count;
      }

      const edgeResult = await session.run(
        `MATCH (n:GraphNode {agentId: $agentId})-[r:RELATION]->()
         RETURN r.type as type, count(r) as count`,
        { agentId }
      );

      let edgeCount = 0;
      for (const record of edgeResult.records) {
        const type = record.get('type') as RelationType;
        const count = (record.get('count') as { low: number }).low;
        if (type in edgesByType) {
          edgesByType[type] = count;
        }
        edgeCount += count;
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
    } finally {
      await session.close();
    }
  }

  private recordToNode(node: Neo4jNode): GraphNode {
    const props = node.properties;
    return {
      id: props.id as string,
      agentId: props.agentId as string,
      type: props.type as EntityType,
      name: props.name as string,
      aliases: (props.aliases as string[]) ?? [],
      description: props.description as string | undefined,
      properties: props.properties ? JSON.parse(props.properties as string) : {},
      embedding: props.embedding as number[] | undefined,
      confidence: props.confidence as number,
      source: props.source as GraphNode['source'],
      createdAt: parseNeo4jDate(props.createdAt),
      updatedAt: parseNeo4jDate(props.updatedAt),
      lastAccessedAt: parseNeo4jDate(props.lastAccessedAt),
      accessCount: (props.accessCount as number) ?? 0,
      metadata: props.metadata ? JSON.parse(props.metadata as string) : undefined,
    };
  }

  private recordToEdge(
    rel: Neo4jRelationship,
    sourceNodeId: string,
    targetNodeId: string
  ): GraphEdge {
    const props = rel.properties;
    return {
      id: props.id as string,
      agentId: props.agentId as string,
      sourceNodeId,
      targetNodeId,
      type: props.type as RelationType,
      label: props.label as string | undefined,
      weight: props.weight as number,
      bidirectional: props.bidirectional as boolean,
      properties: props.properties ? JSON.parse(props.properties as string) : {},
      confidence: props.confidence as number,
      source: props.source as GraphEdge['source'],
      createdAt: parseNeo4jDate(props.createdAt),
      updatedAt: parseNeo4jDate(props.updatedAt),
      validFrom: props.validFrom ? new Date(props.validFrom as string) : undefined,
      validUntil: props.validUntil ? new Date(props.validUntil as string) : undefined,
      metadata: props.metadata ? JSON.parse(props.metadata as string) : undefined,
    };
  }
}

function parseNeo4jDate(value: unknown): Date {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'object' && 'toStandardDate' in (value as object)) {
    return (value as { toStandardDate(): Date }).toStandardDate();
  }
  return new Date();
}

export function createNeo4jGraphAdapter(config: Neo4jGraphAdapterConfig): Neo4jGraphAdapter {
  return new Neo4jGraphAdapter(config);
}
