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

export interface PostgresGraphAdapterConfig {
  connectionString: string;
  schema?: string;
  poolSize?: number;
  vectorDimensions?: number;
}

type Pool = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

type PoolClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
};

export class PostgresGraphAdapter implements GraphAdapter {
  private pool: Pool | null = null;
  private config: PostgresGraphAdapterConfig;
  private schema: string;
  private vectorDimensions: number;

  constructor(config: PostgresGraphAdapterConfig) {
    this.config = config;
    this.schema = config.schema ?? 'cogitator_graph';
    this.vectorDimensions = config.vectorDimensions ?? 1536;
  }

  async connect(): Promise<MemoryResult<void>> {
    try {
      const pg = await import('pg');
      const { Pool } = pg.default ?? pg;

      this.pool = new Pool({
        connectionString: this.config.connectionString,
        max: this.config.poolSize ?? 10,
      }) as Pool;

      const client = await this.pool.connect();
      client.release();

      await this.initSchema();

      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: `Postgres connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async initSchema(): Promise<void> {
    if (!this.pool) return;

    if (!/^[a-z_][a-z0-9_]*$/i.test(this.schema)) {
      throw new Error(`Invalid schema name: ${this.schema}`);
    }

    if (!Number.isInteger(this.vectorDimensions) || this.vectorDimensions <= 0) {
      throw new Error(`Invalid vector dimensions: ${this.vectorDimensions}`);
    }

    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {}

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.graph_nodes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases TEXT[] DEFAULT '{}',
        description TEXT,
        properties JSONB DEFAULT '{}',
        embedding vector(${this.vectorDimensions}),
        confidence REAL DEFAULT 0.5,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
        access_count INTEGER DEFAULT 0,
        metadata JSONB DEFAULT '{}'
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.graph_edges (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL REFERENCES ${this.schema}.graph_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES ${this.schema}.graph_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        label TEXT,
        weight REAL DEFAULT 1.0,
        bidirectional BOOLEAN DEFAULT false,
        properties JSONB DEFAULT '{}',
        confidence REAL DEFAULT 0.5,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_agent ON ${this.schema}.graph_nodes(agent_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON ${this.schema}.graph_nodes(agent_id, type)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON ${this.schema}.graph_nodes(agent_id, name)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_agent ON ${this.schema}.graph_edges(agent_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON ${this.schema}.graph_edges(source_node_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON ${this.schema}.graph_edges(target_node_id)
    `);

    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_embedding
        ON ${this.schema}.graph_nodes
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch {}
  }

  async disconnect(): Promise<MemoryResult<void>> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    return { success: true, data: undefined };
  }

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const id = nanoid();
    const now = new Date();
    const embeddingStr = node.embedding ? `[${node.embedding.join(',')}]` : null;

    await this.pool.query(
      `INSERT INTO ${this.schema}.graph_nodes
       (id, agent_id, type, name, aliases, description, properties, embedding, confidence, source, metadata, created_at, updated_at, last_accessed_at, access_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $12, 0)`,
      [
        id,
        node.agentId,
        node.type,
        node.name,
        node.aliases,
        node.description ?? null,
        node.properties,
        embeddingStr,
        node.confidence,
        node.source,
        node.metadata ?? {},
        now,
      ]
    );

    return {
      success: true,
      data: {
        ...node,
        id,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      },
    };
  }

  async getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const result = await this.pool.query(
      `UPDATE ${this.schema}.graph_nodes
       SET last_accessed_at = NOW(), access_count = access_count + 1
       WHERE id = $1
       RETURNING *`,
      [nodeId]
    );

    if (result.rows.length === 0) return { success: true, data: null };

    return { success: true, data: this.rowToNode(result.rows[0]) };
  }

  async getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const result = await this.pool.query(
      `UPDATE ${this.schema}.graph_nodes
       SET last_accessed_at = NOW(), access_count = access_count + 1
       WHERE id = (
         SELECT id FROM ${this.schema}.graph_nodes
         WHERE agent_id = $1 AND (name = $2 OR $2 = ANY(aliases))
         LIMIT 1
       )
       RETURNING *`,
      [agentId, name]
    );

    if (result.rows.length === 0) return { success: true, data: null };

    return { success: true, data: this.rowToNode(result.rows[0]) };
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
    if (!this.pool) return { success: false, error: 'Not connected' };

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.aliases !== undefined) {
      setClauses.push(`aliases = $${paramIndex++}`);
      params.push(updates.aliases);
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      params.push(updates.description);
    }
    if (updates.properties !== undefined) {
      setClauses.push(`properties = $${paramIndex++}`);
      params.push(updates.properties);
    }
    if (updates.confidence !== undefined) {
      setClauses.push(`confidence = $${paramIndex++}`);
      params.push(updates.confidence);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(updates.metadata);
    }
    if (updates.embedding !== undefined) {
      setClauses.push(`embedding = $${paramIndex++}`);
      params.push(`[${updates.embedding.join(',')}]`);
    }

    params.push(nodeId);

    const result = await this.pool.query(
      `UPDATE ${this.schema}.graph_nodes SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return { success: false, error: `Node ${nodeId} not found` };
    }

    return { success: true, data: this.rowToNode(result.rows[0]) };
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.graph_nodes WHERE id = $1 RETURNING id`,
      [nodeId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: `Node ${nodeId} not found` };
    }

    return { success: true, data: undefined };
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    let sql = `SELECT * FROM ${this.schema}.graph_nodes WHERE agent_id = $1`;
    const params: unknown[] = [query.agentId];
    let paramIndex = 2;

    if (query.types && query.types.length > 0) {
      sql += ` AND type = ANY($${paramIndex++})`;
      params.push(query.types);
    }
    if (query.minConfidence !== undefined) {
      sql += ` AND confidence >= $${paramIndex++}`;
      params.push(query.minConfidence);
    }
    if (query.namePattern) {
      sql += ` AND (name ~* $${paramIndex} OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ~* $${paramIndex}))`;
      params.push(query.namePattern);
      paramIndex++;
    }

    if (query.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }

    const result = await this.pool.query(sql, params);

    return {
      success: true,
      data: result.rows.map((row) => {
        const node = this.rowToNode(row);
        if (!query.includeEmbedding) {
          node.embedding = undefined;
        }
        return node;
      }),
    };
  }

  async searchNodesSemantic(
    options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    if (!this.pool) return { success: false, error: 'Not connected' };
    if (!options.vector) return { success: true, data: [] };

    const vectorStr = `[${options.vector.join(',')}]`;
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.7;

    let sql = `
      SELECT *, 1 - (embedding <=> $1) as score
      FROM ${this.schema}.graph_nodes
      WHERE agent_id = $2
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> $1) >= $3
    `;
    const params: unknown[] = [vectorStr, options.agentId, threshold];
    let paramIndex = 4;

    if (options.entityTypes && options.entityTypes.length > 0) {
      sql += ` AND type = ANY($${paramIndex++})`;
      params.push(options.entityTypes);
    }

    sql += ` ORDER BY embedding <=> $1 LIMIT $${paramIndex}`;
    params.push(limit);

    const result = await this.pool.query(sql, params);

    return {
      success: true,
      data: result.rows.map((row) => ({
        ...this.rowToNode(row),
        score: row.score as number,
      })),
    };
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const id = nanoid();
    const now = new Date();

    await this.pool.query(
      `INSERT INTO ${this.schema}.graph_edges
       (id, agent_id, source_node_id, target_node_id, type, label, weight, bidirectional, properties, confidence, source, valid_from, valid_until, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
      [
        id,
        edge.agentId,
        edge.sourceNodeId,
        edge.targetNodeId,
        edge.type,
        edge.label ?? null,
        edge.weight,
        edge.bidirectional,
        edge.properties,
        edge.confidence,
        edge.source,
        edge.validFrom ?? null,
        edge.validUntil ?? null,
        edge.metadata ?? {},
        now,
      ]
    );

    return {
      success: true,
      data: {
        ...edge,
        id,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  async getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.graph_edges WHERE id = $1`, [
      edgeId,
    ]);

    if (result.rows.length === 0) return { success: true, data: null };

    return { success: true, data: this.rowToEdge(result.rows[0]) };
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.graph_edges WHERE source_node_id = $1 AND target_node_id = $2`,
      [sourceNodeId, targetNodeId]
    );

    return { success: true, data: result.rows.map((row) => this.rowToEdge(row)) };
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
    if (!this.pool) return { success: false, error: 'Not connected' };

    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.weight !== undefined) {
      setClauses.push(`weight = $${paramIndex++}`);
      params.push(updates.weight);
    }
    if (updates.label !== undefined) {
      setClauses.push(`label = $${paramIndex++}`);
      params.push(updates.label);
    }
    if (updates.properties !== undefined) {
      setClauses.push(`properties = $${paramIndex++}`);
      params.push(updates.properties);
    }
    if (updates.confidence !== undefined) {
      setClauses.push(`confidence = $${paramIndex++}`);
      params.push(updates.confidence);
    }
    if (updates.validFrom !== undefined) {
      setClauses.push(`valid_from = $${paramIndex++}`);
      params.push(updates.validFrom);
    }
    if (updates.validUntil !== undefined) {
      setClauses.push(`valid_until = $${paramIndex++}`);
      params.push(updates.validUntil);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      params.push(updates.metadata);
    }

    params.push(edgeId);

    const result = await this.pool.query(
      `UPDATE ${this.schema}.graph_edges SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return { success: false, error: `Edge ${edgeId} not found` };
    }

    return { success: true, data: this.rowToEdge(result.rows[0]) };
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.graph_edges WHERE id = $1 RETURNING id`,
      [edgeId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: `Edge ${edgeId} not found` };
    }

    return { success: true, data: undefined };
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    let sql = `SELECT * FROM ${this.schema}.graph_edges WHERE agent_id = $1`;
    const params: unknown[] = [query.agentId];
    let paramIndex = 2;

    if (query.sourceNodeId) {
      sql += ` AND source_node_id = $${paramIndex++}`;
      params.push(query.sourceNodeId);
    }
    if (query.targetNodeId) {
      sql += ` AND target_node_id = $${paramIndex++}`;
      params.push(query.targetNodeId);
    }
    if (query.types && query.types.length > 0) {
      sql += ` AND type = ANY($${paramIndex++})`;
      params.push(query.types);
    }
    if (query.minWeight !== undefined) {
      sql += ` AND weight >= $${paramIndex++}`;
      params.push(query.minWeight);
    }
    if (query.minConfidence !== undefined) {
      sql += ` AND confidence >= $${paramIndex++}`;
      params.push(query.minConfidence);
    }
    if (query.bidirectionalOnly) {
      sql += ` AND bidirectional = true`;
    }

    if (query.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }

    const result = await this.pool.query(sql, params);

    return { success: true, data: result.rows.map((row) => this.rowToEdge(row)) };
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
    if (!this.pool) return { success: false, error: 'Not connected' };

    const results: { node: GraphNode; edge: GraphEdge }[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outResult = await this.pool.query(
        `SELECT
           e.id as e_id, e.agent_id as e_agent_id, e.source_node_id, e.target_node_id,
           e.type as e_type, e.label as e_label, e.weight as e_weight,
           e.bidirectional as e_bidirectional, e.properties as e_properties,
           e.confidence as e_confidence, e.source as e_source,
           e.created_at as e_created_at, e.updated_at as e_updated_at,
           e.valid_from as e_valid_from, e.valid_until as e_valid_until,
           e.metadata as e_metadata,
           n.id as n_id, n.agent_id as n_agent_id, n.type as n_type, n.name as n_name,
           n.aliases as n_aliases, n.description as n_description, n.properties as n_properties,
           n.embedding as n_embedding, n.confidence as n_confidence, n.source as n_source,
           n.created_at as n_created_at, n.updated_at as n_updated_at,
           n.last_accessed_at as n_last_accessed_at, n.access_count as n_access_count,
           n.metadata as n_metadata
         FROM ${this.schema}.graph_edges e
         JOIN ${this.schema}.graph_nodes n ON e.target_node_id = n.id
         WHERE e.source_node_id = $1`,
        [nodeId]
      );

      for (const row of outResult.rows) {
        results.push({
          edge: this.joinRowToEdge(row),
          node: this.joinRowToNode(row),
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const inResult = await this.pool.query(
        `SELECT
           e.id as e_id, e.agent_id as e_agent_id, e.source_node_id, e.target_node_id,
           e.type as e_type, e.label as e_label, e.weight as e_weight,
           e.bidirectional as e_bidirectional, e.properties as e_properties,
           e.confidence as e_confidence, e.source as e_source,
           e.created_at as e_created_at, e.updated_at as e_updated_at,
           e.valid_from as e_valid_from, e.valid_until as e_valid_until,
           e.metadata as e_metadata,
           n.id as n_id, n.agent_id as n_agent_id, n.type as n_type, n.name as n_name,
           n.aliases as n_aliases, n.description as n_description, n.properties as n_properties,
           n.embedding as n_embedding, n.confidence as n_confidence, n.source as n_source,
           n.created_at as n_created_at, n.updated_at as n_updated_at,
           n.last_accessed_at as n_last_accessed_at, n.access_count as n_access_count,
           n.metadata as n_metadata
         FROM ${this.schema}.graph_edges e
         JOIN ${this.schema}.graph_nodes n ON e.source_node_id = n.id
         WHERE e.target_node_id = $1`,
        [nodeId]
      );

      for (const row of inResult.rows) {
        results.push({
          edge: this.joinRowToEdge(row),
          node: this.joinRowToNode(row),
        });
      }
    }

    return { success: true, data: results };
  }

  async mergeNodes(
    targetNodeId: string,
    sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const sourceId of sourceNodeIds) {
        await client.query(
          `UPDATE ${this.schema}.graph_edges
           SET source_node_id = $1
           WHERE source_node_id = $2 AND target_node_id != $1`,
          [targetNodeId, sourceId]
        );

        await client.query(
          `UPDATE ${this.schema}.graph_edges
           SET target_node_id = $1
           WHERE target_node_id = $2 AND source_node_id != $1`,
          [targetNodeId, sourceId]
        );

        await client.query(`DELETE FROM ${this.schema}.graph_nodes WHERE id = $1`, [sourceId]);
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return this.updateNode(targetNodeId, {
      aliases: Array.from(allAliases),
      properties: allProperties,
    });
  }

  async clearGraph(agentId: string): Promise<MemoryResult<void>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

    await this.pool.query(`DELETE FROM ${this.schema}.graph_nodes WHERE agent_id = $1`, [agentId]);

    return { success: true, data: undefined };
  }

  async getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>> {
    if (!this.pool) return { success: false, error: 'Not connected' };

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

    const nodeCountResult = await this.pool.query(
      `SELECT type, COUNT(*) as count FROM ${this.schema}.graph_nodes WHERE agent_id = $1 GROUP BY type`,
      [agentId]
    );

    let nodeCount = 0;
    for (const row of nodeCountResult.rows) {
      const type = row.type as EntityType;
      const count = Number(row.count);
      if (type in nodesByType) {
        nodesByType[type] = count;
      }
      nodeCount += count;
    }

    const edgeCountResult = await this.pool.query(
      `SELECT type, COUNT(*) as count FROM ${this.schema}.graph_edges WHERE agent_id = $1 GROUP BY type`,
      [agentId]
    );

    let edgeCount = 0;
    for (const row of edgeCountResult.rows) {
      const type = row.type as RelationType;
      const count = Number(row.count);
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
  }

  private rowToNode(row: Record<string, unknown>): GraphNode {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      type: row.type as EntityType,
      name: row.name as string,
      aliases: (row.aliases as string[]) ?? [],
      description: row.description as string | undefined,
      properties: (row.properties as Record<string, unknown>) ?? {},
      embedding: row.embedding
        ? ((typeof row.embedding === 'string'
            ? JSON.parse(row.embedding)
            : row.embedding) as number[])
        : undefined,
      confidence: row.confidence as number,
      source: row.source as GraphNode['source'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      lastAccessedAt: new Date(row.last_accessed_at as string),
      accessCount: row.access_count as number,
      metadata: row.metadata as Record<string, unknown> | undefined,
    };
  }

  private rowToEdge(row: Record<string, unknown>): GraphEdge {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      sourceNodeId: row.source_node_id as string,
      targetNodeId: row.target_node_id as string,
      type: row.type as RelationType,
      label: row.label as string | undefined,
      weight: row.weight as number,
      bidirectional: row.bidirectional as boolean,
      properties: (row.properties as Record<string, unknown>) ?? {},
      confidence: row.confidence as number,
      source: row.source as GraphEdge['source'],
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      validFrom: row.valid_from ? new Date(row.valid_from as string) : undefined,
      validUntil: row.valid_until ? new Date(row.valid_until as string) : undefined,
      metadata: row.metadata as Record<string, unknown> | undefined,
    };
  }

  private joinRowToNode(row: Record<string, unknown>): GraphNode {
    return {
      id: row.n_id as string,
      agentId: row.n_agent_id as string,
      type: row.n_type as EntityType,
      name: row.n_name as string,
      aliases: (row.n_aliases as string[]) ?? [],
      description: row.n_description as string | undefined,
      properties: (row.n_properties as Record<string, unknown>) ?? {},
      embedding: row.n_embedding
        ? ((typeof row.n_embedding === 'string'
            ? JSON.parse(row.n_embedding)
            : row.n_embedding) as number[])
        : undefined,
      confidence: row.n_confidence as number,
      source: row.n_source as GraphNode['source'],
      createdAt: new Date(row.n_created_at as string),
      updatedAt: new Date(row.n_updated_at as string),
      lastAccessedAt: new Date(row.n_last_accessed_at as string),
      accessCount: row.n_access_count as number,
      metadata: row.n_metadata as Record<string, unknown> | undefined,
    };
  }

  private joinRowToEdge(row: Record<string, unknown>): GraphEdge {
    return {
      id: row.e_id as string,
      agentId: row.e_agent_id as string,
      sourceNodeId: row.source_node_id as string,
      targetNodeId: row.target_node_id as string,
      type: row.e_type as RelationType,
      label: row.e_label as string | undefined,
      weight: row.e_weight as number,
      bidirectional: row.e_bidirectional as boolean,
      properties: (row.e_properties as Record<string, unknown>) ?? {},
      confidence: row.e_confidence as number,
      source: row.e_source as GraphEdge['source'],
      createdAt: new Date(row.e_created_at as string),
      updatedAt: new Date(row.e_updated_at as string),
      validFrom: row.e_valid_from ? new Date(row.e_valid_from as string) : undefined,
      validUntil: row.e_valid_until ? new Date(row.e_valid_until as string) : undefined,
      metadata: row.e_metadata as Record<string, unknown> | undefined,
    };
  }
}

export function createPostgresGraphAdapter(
  config: PostgresGraphAdapterConfig
): PostgresGraphAdapter {
  return new PostgresGraphAdapter(config);
}
