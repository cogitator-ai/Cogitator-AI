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
  MemoryResult,
  TraversalDirection,
  EntityType,
  RelationType,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

type Pool = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{ release(): void }>;
  end(): Promise<void>;
};

export interface PostgresGraphAdapterConfig {
  pool: Pool;
  schema?: string;
  vectorDimensions?: number;
}

export class PostgresGraphAdapter implements GraphAdapter {
  private pool: Pool;
  private schema: string;
  private vectorDimensions: number;
  private initPromise?: Promise<void>;

  constructor(config: PostgresGraphAdapterConfig) {
    this.pool = config.pool;
    const schema = config.schema ?? 'cogitator';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      throw new Error(
        `Invalid schema name "${schema}": must be alphanumeric with underscores, starting with a letter or underscore`
      );
    }
    this.schema = schema;
    const dims = config.vectorDimensions ?? 768;
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`Invalid vectorDimensions: must be a positive integer`);
    }
    this.vectorDimensions = dims;
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
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
        confidence REAL NOT NULL DEFAULT 1.0,
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
        weight REAL NOT NULL DEFAULT 1.0,
        bidirectional BOOLEAN DEFAULT FALSE,
        properties JSONB DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}'
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_agent_id
      ON ${this.schema}.graph_nodes(agent_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type
      ON ${this.schema}.graph_nodes(agent_id, type)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_name
      ON ${this.schema}.graph_nodes(agent_id, name)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_agent_id
      ON ${this.schema}.graph_edges(agent_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source
      ON ${this.schema}.graph_edges(source_node_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target
      ON ${this.schema}.graph_edges(target_node_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type
      ON ${this.schema}.graph_edges(agent_id, type)
    `);

    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_graph_nodes_embedding
        ON ${this.schema}.graph_nodes
        USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch {}
  }

  private success<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  private failure(error: string): MemoryResult<never> {
    return { success: false, error };
  }

  private generateId(prefix: string): string {
    return `${prefix}_${nanoid(12)}`;
  }

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    await this.initialize();

    const id = this.generateId('node');
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

    return this.success({
      ...node,
      id,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    });
  }

  async getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>> {
    await this.initialize();

    await this.pool.query(
      `UPDATE ${this.schema}.graph_nodes
       SET last_accessed_at = NOW(), access_count = access_count + 1
       WHERE id = $1`,
      [nodeId]
    );

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.graph_nodes WHERE id = $1`, [
      nodeId,
    ]);

    if (result.rows.length === 0) return this.success(null);

    return this.success(this.rowToNode(result.rows[0]));
  }

  async getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    await this.initialize();

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.graph_nodes
       WHERE agent_id = $1 AND (name = $2 OR $2 = ANY(aliases))`,
      [agentId, name]
    );

    if (result.rows.length === 0) return this.success(null);

    return this.success(this.rowToNode(result.rows[0]));
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
    await this.initialize();

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
      return this.failure(`Node not found: ${nodeId}`);
    }

    return this.success(this.rowToNode(result.rows[0]));
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    await this.initialize();
    await this.pool.query(`DELETE FROM ${this.schema}.graph_nodes WHERE id = $1`, [nodeId]);
    return this.success(undefined);
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    await this.initialize();

    let sql = `SELECT * FROM ${this.schema}.graph_nodes WHERE agent_id = $1`;
    const params: unknown[] = [query.agentId];
    let paramIndex = 2;

    if (query.types && query.types.length > 0) {
      sql += ` AND type = ANY($${paramIndex++})`;
      params.push(query.types);
    }
    if (query.namePattern) {
      sql += ` AND name ILIKE $${paramIndex++}`;
      params.push(`%${query.namePattern.replace(/[%_\\]/g, '\\$&')}%`);
    }
    if (query.minConfidence !== undefined) {
      sql += ` AND confidence >= $${paramIndex++}`;
      params.push(query.minConfidence);
    }

    sql += ' ORDER BY access_count DESC, updated_at DESC';

    if (query.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }

    const result = await this.pool.query(sql, params);

    return this.success(result.rows.map((row) => this.rowToNode(row, query.includeEmbedding)));
  }

  async searchNodesSemantic(
    options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    await this.initialize();

    if (!options.vector) {
      return this.failure('searchNodesSemantic requires vector');
    }

    const vectorStr = `[${options.vector.join(',')}]`;
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.7;

    let sql = `
      SELECT *, 1 - (embedding <=> $1) as score
      FROM ${this.schema}.graph_nodes
      WHERE agent_id = $2 AND embedding IS NOT NULL AND 1 - (embedding <=> $1) >= $3
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

    return this.success(
      result.rows.map((row) => ({
        ...this.rowToNode(row),
        score: row.score as number,
      }))
    );
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    await this.initialize();

    const id = this.generateId('edge');
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

    return this.success({
      ...edge,
      id,
      createdAt: now,
      updatedAt: now,
    });
  }

  async getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>> {
    await this.initialize();

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.graph_edges WHERE id = $1`, [
      edgeId,
    ]);

    if (result.rows.length === 0) return this.success(null);

    return this.success(this.rowToEdge(result.rows[0]));
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    await this.initialize();

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.graph_edges
       WHERE (source_node_id = $1 AND target_node_id = $2)
          OR (bidirectional = TRUE AND source_node_id = $2 AND target_node_id = $1)`,
      [sourceNodeId, targetNodeId]
    );

    return this.success(result.rows.map((row) => this.rowToEdge(row)));
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
    await this.initialize();

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
      return this.failure(`Edge not found: ${edgeId}`);
    }

    return this.success(this.rowToEdge(result.rows[0]));
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    await this.initialize();
    await this.pool.query(`DELETE FROM ${this.schema}.graph_edges WHERE id = $1`, [edgeId]);
    return this.success(undefined);
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    await this.initialize();

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
      sql += ' AND bidirectional = TRUE';
    }

    sql += ' ORDER BY weight DESC, confidence DESC';

    if (query.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }

    const result = await this.pool.query(sql, params);

    return this.success(result.rows.map((row) => this.rowToEdge(row)));
  }

  async traverse(options: TraversalOptions): Promise<MemoryResult<TraversalResult>> {
    await this.initialize();

    const visited = new Set<string>();
    const visitedEdges = new Set<string>();
    const paths: GraphPath[] = [];
    const allNodes: GraphNode[] = [];
    const allEdges: GraphEdge[] = [];

    const startNodeResult = await this.getNode(options.startNodeId);
    if (!startNodeResult.success || !startNodeResult.data) {
      return this.failure(`Start node not found: ${options.startNodeId}`);
    }

    const startNode = startNodeResult.data;
    visited.add(startNode.id);
    allNodes.push(startNode);

    await this.traverseRecursive(
      startNode,
      [],
      [],
      0,
      options,
      visited,
      visitedEdges,
      paths,
      allNodes,
      allEdges
    );

    let actualMaxDepth = 0;
    for (const p of paths) {
      if (p.length > actualMaxDepth) actualMaxDepth = p.length;
    }

    return this.success({
      paths,
      visitedNodes: allNodes,
      visitedEdges: allEdges,
      depth: actualMaxDepth,
    });
  }

  private async traverseRecursive(
    currentNode: GraphNode,
    pathNodes: GraphNode[],
    pathEdges: GraphEdge[],
    currentDepth: number,
    options: TraversalOptions,
    visited: Set<string>,
    visitedEdges: Set<string>,
    paths: GraphPath[],
    allNodes: GraphNode[],
    allEdges: GraphEdge[]
  ): Promise<void> {
    if (currentDepth >= options.maxDepth) {
      if (pathNodes.length > 0) {
        paths.push({
          nodes: [...pathNodes, currentNode],
          edges: [...pathEdges],
          totalWeight: pathEdges.reduce((sum, e) => sum + e.weight, 0),
          length: pathEdges.length,
        });
      }
      return;
    }

    if (options.limit && paths.length >= options.limit) return;

    const neighborsResult = await this.getNeighbors(currentNode.id, options.direction);
    if (!neighborsResult.success) return;

    let hasUnvisitedNeighbors = false;

    for (const { node, edge } of neighborsResult.data) {
      if (options.edgeTypes && !options.edgeTypes.includes(edge.type)) continue;
      if (options.minEdgeWeight !== undefined && edge.weight < options.minEdgeWeight) continue;
      if (options.minConfidence !== undefined && edge.confidence < options.minConfidence) continue;

      if (!visitedEdges.has(edge.id)) {
        visitedEdges.add(edge.id);
        allEdges.push(edge);
      }

      if (!visited.has(node.id)) {
        hasUnvisitedNeighbors = true;
        visited.add(node.id);
        allNodes.push(node);

        await this.traverseRecursive(
          node,
          [...pathNodes, currentNode],
          [...pathEdges, edge],
          currentDepth + 1,
          options,
          visited,
          visitedEdges,
          paths,
          allNodes,
          allEdges
        );
      }
    }

    if (!hasUnvisitedNeighbors && pathNodes.length > 0) {
      paths.push({
        nodes: [...pathNodes, currentNode],
        edges: [...pathEdges],
        totalWeight: pathEdges.reduce((sum, e) => sum + e.weight, 0),
        length: pathEdges.length,
      });
    }
  }

  async findShortestPath(
    agentId: string,
    startNodeId: string,
    endNodeId: string,
    maxDepth = 5
  ): Promise<MemoryResult<GraphPath | null>> {
    await this.initialize();

    const result = await this.pool.query(
      `
      WITH RECURSIVE path_search AS (
        SELECT
          source_node_id as start_node,
          CASE
            WHEN source_node_id = $2 THEN target_node_id
            ELSE source_node_id
          END as end_node,
          ARRAY[$2, CASE WHEN source_node_id = $2 THEN target_node_id ELSE source_node_id END] as path,
          ARRAY[id] as edge_ids,
          weight as total_weight,
          1 as depth
        FROM ${this.schema}.graph_edges
        WHERE agent_id = $1
          AND (source_node_id = $2 OR (target_node_id = $2 AND bidirectional = TRUE))

        UNION ALL

        SELECT
          ps.start_node,
          CASE
            WHEN e.source_node_id = ps.end_node THEN e.target_node_id
            ELSE e.source_node_id
          END,
          ps.path || CASE WHEN e.source_node_id = ps.end_node THEN e.target_node_id ELSE e.source_node_id END,
          ps.edge_ids || e.id,
          ps.total_weight + e.weight,
          ps.depth + 1
        FROM path_search ps
        JOIN ${this.schema}.graph_edges e ON (
          e.source_node_id = ps.end_node
          OR (e.target_node_id = ps.end_node AND e.bidirectional = TRUE)
        )
        WHERE e.agent_id = $1
          AND NOT (CASE WHEN e.source_node_id = ps.end_node THEN e.target_node_id ELSE e.source_node_id END) = ANY(ps.path)
          AND ps.depth < $4
      )
      SELECT path, edge_ids, total_weight
      FROM path_search
      WHERE end_node = $3
      ORDER BY depth, total_weight
      LIMIT 1
      `,
      [agentId, startNodeId, endNodeId, maxDepth]
    );

    if (result.rows.length === 0) return this.success(null);

    const row = result.rows[0];
    const nodeIds = row.path as string[];
    const edgeIds = row.edge_ids as string[];

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const nodeId of nodeIds) {
      const nodeResult = await this.getNode(nodeId);
      if (nodeResult.success && nodeResult.data) {
        nodes.push(nodeResult.data);
      }
    }

    for (const edgeId of edgeIds) {
      const edgeResult = await this.getEdge(edgeId);
      if (edgeResult.success && edgeResult.data) {
        edges.push(edgeResult.data);
      }
    }

    return this.success({
      nodes,
      edges,
      totalWeight: row.total_weight as number,
      length: edges.length,
    });
  }

  async getNeighbors(
    nodeId: string,
    direction: TraversalDirection = 'both'
  ): Promise<MemoryResult<{ node: GraphNode; edge: GraphEdge }[]>> {
    await this.initialize();

    let sql: string;
    const params = [nodeId];

    const selectCols = `
      n.id, n.agent_id, n.type, n.name, n.aliases, n.description,
      n.properties, n.confidence, n.source, n.metadata,
      n.created_at, n.updated_at, n.last_accessed_at, n.access_count,
      e.id as edge_id, e.agent_id as edge_agent_id, e.type as edge_type,
      e.source_node_id, e.target_node_id, e.label, e.weight, e.bidirectional,
      e.properties as edge_properties, e.confidence as edge_confidence,
      e.source as edge_source, e.valid_from, e.valid_until,
      e.metadata as edge_metadata, e.created_at as edge_created_at, e.updated_at as edge_updated_at
    `;

    if (direction === 'outgoing') {
      sql = `
        SELECT ${selectCols}
        FROM ${this.schema}.graph_edges e
        JOIN ${this.schema}.graph_nodes n ON n.id = e.target_node_id
        WHERE e.source_node_id = $1
           OR (e.target_node_id = $1 AND e.bidirectional = TRUE AND n.id = e.source_node_id)
      `;
    } else if (direction === 'incoming') {
      sql = `
        SELECT ${selectCols}
        FROM ${this.schema}.graph_edges e
        JOIN ${this.schema}.graph_nodes n ON n.id = e.source_node_id
        WHERE e.target_node_id = $1
           OR (e.source_node_id = $1 AND e.bidirectional = TRUE AND n.id = e.target_node_id)
      `;
    } else {
      sql = `
        SELECT ${selectCols}
        FROM ${this.schema}.graph_edges e
        JOIN ${this.schema}.graph_nodes n ON (
          (e.source_node_id = $1 AND n.id = e.target_node_id) OR
          (e.target_node_id = $1 AND n.id = e.source_node_id)
        )
        WHERE e.source_node_id = $1 OR e.target_node_id = $1
      `;
    }

    const result = await this.pool.query(sql, params);

    return this.success(
      result.rows.map((row) => ({
        node: this.rowToNode(row),
        edge: this.rowToEdgeFromJoin(row),
      }))
    );
  }

  async mergeNodes(
    targetNodeId: string,
    sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    await this.initialize();

    for (const sourceId of sourceNodeIds) {
      const sourceNode = await this.getNode(sourceId);

      await this.pool.query(
        `UPDATE ${this.schema}.graph_edges
         SET source_node_id = $1 WHERE source_node_id = $2`,
        [targetNodeId, sourceId]
      );
      await this.pool.query(
        `UPDATE ${this.schema}.graph_edges
         SET target_node_id = $1 WHERE target_node_id = $2`,
        [targetNodeId, sourceId]
      );

      await this.pool.query(
        `DELETE FROM ${this.schema}.graph_edges
         WHERE source_node_id = target_node_id`
      );

      if (sourceNode.success && sourceNode.data) {
        await this.pool.query(
          `UPDATE ${this.schema}.graph_nodes
           SET aliases = array_cat(aliases, $1::TEXT[])
           WHERE id = $2`,
          [[sourceNode.data.name, ...sourceNode.data.aliases], targetNodeId]
        );
      }

      await this.deleteNode(sourceId);
    }

    const mergedNode = await this.getNode(targetNodeId);
    if (!mergedNode.success || !mergedNode.data) {
      return this.failure(`Target node not found: ${targetNodeId}`);
    }

    return this.success(mergedNode.data);
  }

  async clearGraph(agentId: string): Promise<MemoryResult<void>> {
    await this.initialize();
    await this.pool.query(`DELETE FROM ${this.schema}.graph_nodes WHERE agent_id = $1`, [agentId]);
    return this.success(undefined);
  }

  async getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>> {
    await this.initialize();

    const nodeCountResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${this.schema}.graph_nodes WHERE agent_id = $1`,
      [agentId]
    );

    const edgeCountResult = await this.pool.query(
      `SELECT COUNT(*) as count FROM ${this.schema}.graph_edges WHERE agent_id = $1`,
      [agentId]
    );

    const nodesByTypeResult = await this.pool.query(
      `SELECT type, COUNT(*) as count FROM ${this.schema}.graph_nodes WHERE agent_id = $1 GROUP BY type`,
      [agentId]
    );

    const edgesByTypeResult = await this.pool.query(
      `SELECT type, COUNT(*) as count FROM ${this.schema}.graph_edges WHERE agent_id = $1 GROUP BY type`,
      [agentId]
    );

    const nodeCount = parseInt((nodeCountResult.rows[0]?.count as string) ?? '0', 10);
    const edgeCount = parseInt((edgeCountResult.rows[0]?.count as string) ?? '0', 10);

    const nodesByType: Record<EntityType, number> = {} as Record<EntityType, number>;
    for (const row of nodesByTypeResult.rows) {
      nodesByType[row.type as EntityType] = parseInt(row.count as string, 10);
    }

    const edgesByType: Record<RelationType, number> = {} as Record<RelationType, number>;
    for (const row of edgesByTypeResult.rows) {
      edgesByType[row.type as RelationType] = parseInt(row.count as string, 10);
    }

    return this.success({
      nodeCount,
      edgeCount,
      nodesByType,
      edgesByType,
      averageEdgesPerNode: nodeCount > 0 ? edgeCount / nodeCount : 0,
      maxDepth: 0,
    });
  }

  private rowToNode(row: Record<string, unknown>, includeEmbedding = false): GraphNode {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      type: row.type as EntityType,
      name: row.name as string,
      aliases: (row.aliases as string[]) ?? [],
      description: row.description as string | undefined,
      properties: (row.properties as Record<string, unknown>) ?? {},
      embedding: includeEmbedding ? (row.embedding as number[] | undefined) : undefined,
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

  private rowToEdgeFromJoin(row: Record<string, unknown>): GraphEdge {
    return {
      id: row.edge_id as string,
      agentId: row.edge_agent_id as string,
      sourceNodeId: row.source_node_id as string,
      targetNodeId: row.target_node_id as string,
      type: row.edge_type as RelationType,
      label: row.label as string | undefined,
      weight: row.weight as number,
      bidirectional: row.bidirectional as boolean,
      properties: (row.edge_properties as Record<string, unknown>) ?? {},
      confidence: row.edge_confidence as number,
      source: row.edge_source as GraphEdge['source'],
      createdAt: new Date(row.edge_created_at as string),
      updatedAt: new Date(row.edge_updated_at as string),
      validFrom: row.valid_from ? new Date(row.valid_from as string) : undefined,
      validUntil: row.valid_until ? new Date(row.valid_until as string) : undefined,
      metadata: row.edge_metadata as Record<string, unknown> | undefined,
    };
  }
}
