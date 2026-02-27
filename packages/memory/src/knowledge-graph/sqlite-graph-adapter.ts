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

interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  pragma(pragma: string): unknown;
}

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface NodeRow {
  id: string;
  agent_id: string;
  name: string;
  type: string;
  aliases: string;
  description: string | null;
  properties: string;
  embedding: string | null;
  confidence: number;
  source: string;
  metadata: string;
  access_count: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
}

interface EdgeRow {
  id: string;
  agent_id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  label: string | null;
  weight: number;
  properties: string;
  confidence: number;
  source: string;
  bidirectional: number;
  valid_from: string | null;
  valid_until: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface NeighborRow extends NodeRow {
  edge_id: string;
  edge_agent_id: string;
  edge_type: string;
  edge_source_node_id: string;
  edge_target_node_id: string;
  edge_label: string | null;
  edge_weight: number;
  edge_bidirectional: number;
  edge_properties: string;
  edge_confidence: number;
  edge_source: string;
  edge_valid_from: string | null;
  edge_valid_until: string | null;
  edge_metadata: string;
  edge_created_at: string;
  edge_updated_at: string;
}

export interface SQLiteGraphAdapterConfig {
  path: string;
  walMode?: boolean;
}

export class SQLiteGraphAdapter implements GraphAdapter {
  private db: Database | null = null;
  private path: string;
  private walMode: boolean;
  private initialized = false;

  constructor(config: SQLiteGraphAdapterConfig) {
    this.path = config.path;
    this.walMode = config.walMode ?? true;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.db) {
      let DatabaseCtor: new (path: string) => Database;
      const betterSqlite = await import('better-sqlite3');
      DatabaseCtor = betterSqlite.default as unknown as new (path: string) => Database;
      this.db = new DatabaseCtor(this.path);

      this.db.pragma('foreign_keys = ON');
      if (this.walMode && this.path !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        aliases TEXT DEFAULT '[]',
        description TEXT,
        properties TEXT DEFAULT '{}',
        embedding TEXT,
        confidence REAL DEFAULT 1.0,
        source TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        access_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        label TEXT,
        weight REAL DEFAULT 1.0,
        properties TEXT DEFAULT '{}',
        confidence REAL DEFAULT 1.0,
        source TEXT NOT NULL,
        bidirectional INTEGER DEFAULT 0,
        valid_from TEXT,
        valid_until TEXT,
        metadata TEXT DEFAULT '{}',
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_graph_nodes_agent_id ON graph_nodes(agent_id);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(agent_id, type);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_name ON graph_nodes(agent_id, name);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_agent_id ON graph_edges(agent_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(agent_id, type);
    `);

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  private ensureDb(): Database {
    if (!this.db) throw new Error('Not initialized');
    return this.db;
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

  private rowToNode(row: NodeRow, includeEmbedding = false): GraphNode {
    return {
      id: row.id,
      agentId: row.agent_id,
      type: row.type as EntityType,
      name: row.name,
      aliases: JSON.parse(row.aliases) as string[],
      description: row.description ?? undefined,
      properties: JSON.parse(row.properties) as Record<string, unknown>,
      embedding:
        includeEmbedding && row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined,
      confidence: row.confidence,
      source: row.source as GraphNode['source'],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastAccessedAt: new Date(row.last_accessed_at),
      accessCount: row.access_count,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    };
  }

  private rowToEdge(row: EdgeRow): GraphEdge {
    return {
      id: row.id,
      agentId: row.agent_id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      type: row.type as RelationType,
      label: row.label ?? undefined,
      weight: row.weight,
      bidirectional: row.bidirectional === 1,
      properties: JSON.parse(row.properties) as Record<string, unknown>,
      confidence: row.confidence,
      source: row.source as GraphEdge['source'],
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      validFrom: row.valid_from ? new Date(row.valid_from) : undefined,
      validUntil: row.valid_until ? new Date(row.valid_until) : undefined,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    };
  }

  private neighborRowToEdge(row: NeighborRow): GraphEdge {
    return {
      id: row.edge_id,
      agentId: row.edge_agent_id,
      sourceNodeId: row.edge_source_node_id,
      targetNodeId: row.edge_target_node_id,
      type: row.edge_type as RelationType,
      label: row.edge_label ?? undefined,
      weight: row.edge_weight,
      bidirectional: row.edge_bidirectional === 1,
      properties: JSON.parse(row.edge_properties) as Record<string, unknown>,
      confidence: row.edge_confidence,
      source: row.edge_source as GraphEdge['source'],
      createdAt: new Date(row.edge_created_at),
      updatedAt: new Date(row.edge_updated_at),
      validFrom: row.edge_valid_from ? new Date(row.edge_valid_from) : undefined,
      validUntil: row.edge_valid_until ? new Date(row.edge_valid_until) : undefined,
      metadata: JSON.parse(row.edge_metadata) as Record<string, unknown>,
    };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    await this.initialize();
    const db = this.ensureDb();

    const id = this.generateId('node');
    const now = new Date();
    const nowStr = now.toISOString();

    db.prepare(
      `INSERT INTO graph_nodes
       (id, agent_id, type, name, aliases, description, properties, embedding, confidence, source, metadata, access_count, created_at, updated_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
      id,
      node.agentId,
      node.type,
      node.name,
      JSON.stringify(node.aliases),
      node.description ?? null,
      JSON.stringify(node.properties),
      node.embedding ? JSON.stringify(node.embedding) : null,
      node.confidence,
      node.source,
      JSON.stringify(node.metadata ?? {}),
      nowStr,
      nowStr,
      nowStr
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
    const db = this.ensureDb();

    db.prepare(
      `UPDATE graph_nodes SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?`
    ).run(new Date().toISOString(), nodeId);

    const row = db.prepare(`SELECT * FROM graph_nodes WHERE id = ?`).get(nodeId) as
      | NodeRow
      | undefined;

    if (!row) return this.success(null);
    return this.success(this.rowToNode(row));
  }

  async getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    await this.initialize();
    const db = this.ensureDb();

    const row = db
      .prepare(`SELECT * FROM graph_nodes WHERE agent_id = ? AND name = ?`)
      .get(agentId, name) as NodeRow | undefined;

    if (row) return this.success(this.rowToNode(row));

    const allRows = db
      .prepare(`SELECT * FROM graph_nodes WHERE agent_id = ?`)
      .all(agentId) as NodeRow[];

    for (const r of allRows) {
      const aliases = JSON.parse(r.aliases) as string[];
      if (aliases.includes(name)) {
        return this.success(this.rowToNode(r));
      }
    }

    return this.success(null);
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
    const db = this.ensureDb();

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.aliases !== undefined) {
      setClauses.push('aliases = ?');
      params.push(JSON.stringify(updates.aliases));
    }
    if (updates.description !== undefined) {
      setClauses.push('description = ?');
      params.push(updates.description);
    }
    if (updates.properties !== undefined) {
      setClauses.push('properties = ?');
      params.push(JSON.stringify(updates.properties));
    }
    if (updates.confidence !== undefined) {
      setClauses.push('confidence = ?');
      params.push(updates.confidence);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.embedding !== undefined) {
      setClauses.push('embedding = ?');
      params.push(JSON.stringify(updates.embedding));
    }

    params.push(nodeId);

    const result = db
      .prepare(`UPDATE graph_nodes SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...params);

    if (result.changes === 0) {
      return this.failure(`Node not found: ${nodeId}`);
    }

    const row = db.prepare(`SELECT * FROM graph_nodes WHERE id = ?`).get(nodeId) as NodeRow;
    return this.success(this.rowToNode(row));
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    await this.initialize();
    const db = this.ensureDb();
    db.prepare(`DELETE FROM graph_nodes WHERE id = ?`).run(nodeId);
    return this.success(undefined);
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    await this.initialize();
    const db = this.ensureDb();

    let sql = `SELECT * FROM graph_nodes WHERE agent_id = ?`;
    const params: unknown[] = [query.agentId];

    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => '?').join(', ');
      sql += ` AND type IN (${placeholders})`;
      params.push(...query.types);
    }
    if (query.namePattern) {
      sql += ` AND name LIKE ?`;
      params.push(`%${query.namePattern.replace(/[%_\\]/g, '\\$&')}%`);
    }
    if (query.minConfidence !== undefined) {
      sql += ` AND confidence >= ?`;
      params.push(query.minConfidence);
    }

    sql += ' ORDER BY access_count DESC, updated_at DESC';

    if (query.limit) {
      sql += ` LIMIT ?`;
      params.push(query.limit);
    }

    const rows = db.prepare(sql).all(...params) as NodeRow[];
    return this.success(rows.map((row) => this.rowToNode(row, query.includeEmbedding)));
  }

  async searchNodesSemantic(
    options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    await this.initialize();
    const db = this.ensureDb();

    if (!options.vector) {
      return this.failure('searchNodesSemantic requires vector');
    }

    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0.7;

    let sql = `SELECT * FROM graph_nodes WHERE agent_id = ? AND embedding IS NOT NULL`;
    const params: unknown[] = [options.agentId];

    if (options.entityTypes && options.entityTypes.length > 0) {
      const placeholders = options.entityTypes.map(() => '?').join(', ');
      sql += ` AND type IN (${placeholders})`;
      params.push(...options.entityTypes);
    }

    const rows = db.prepare(sql).all(...params) as NodeRow[];

    const scored: (GraphNode & { score: number })[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = JSON.parse(row.embedding) as number[];
      const score = this.cosineSimilarity(options.vector, emb);
      if (score >= threshold) {
        scored.push({ ...this.rowToNode(row), score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return this.success(scored.slice(0, limit));
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    await this.initialize();
    const db = this.ensureDb();

    const id = this.generateId('edge');
    const now = new Date();
    const nowStr = now.toISOString();

    db.prepare(
      `INSERT INTO graph_edges
       (id, agent_id, source_node_id, target_node_id, type, label, weight, bidirectional, properties, confidence, source, valid_from, valid_until, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      edge.agentId,
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.type,
      edge.label ?? null,
      edge.weight,
      edge.bidirectional ? 1 : 0,
      JSON.stringify(edge.properties),
      edge.confidence,
      edge.source,
      edge.validFrom?.toISOString() ?? null,
      edge.validUntil?.toISOString() ?? null,
      JSON.stringify(edge.metadata ?? {}),
      nowStr,
      nowStr
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
    const db = this.ensureDb();

    const row = db.prepare(`SELECT * FROM graph_edges WHERE id = ?`).get(edgeId) as
      | EdgeRow
      | undefined;

    if (!row) return this.success(null);
    return this.success(this.rowToEdge(row));
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    await this.initialize();
    const db = this.ensureDb();

    const rows = db
      .prepare(
        `SELECT * FROM graph_edges
         WHERE (source_node_id = ? AND target_node_id = ?)
            OR (bidirectional = 1 AND source_node_id = ? AND target_node_id = ?)`
      )
      .all(sourceNodeId, targetNodeId, targetNodeId, sourceNodeId) as EdgeRow[];

    return this.success(rows.map((row) => this.rowToEdge(row)));
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
    const db = this.ensureDb();

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.weight !== undefined) {
      setClauses.push('weight = ?');
      params.push(updates.weight);
    }
    if (updates.label !== undefined) {
      setClauses.push('label = ?');
      params.push(updates.label);
    }
    if (updates.properties !== undefined) {
      setClauses.push('properties = ?');
      params.push(JSON.stringify(updates.properties));
    }
    if (updates.confidence !== undefined) {
      setClauses.push('confidence = ?');
      params.push(updates.confidence);
    }
    if (updates.validFrom !== undefined) {
      setClauses.push('valid_from = ?');
      params.push(updates.validFrom.toISOString());
    }
    if (updates.validUntil !== undefined) {
      setClauses.push('valid_until = ?');
      params.push(updates.validUntil.toISOString());
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }

    params.push(edgeId);

    const result = db
      .prepare(`UPDATE graph_edges SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...params);

    if (result.changes === 0) {
      return this.failure(`Edge not found: ${edgeId}`);
    }

    const row = db.prepare(`SELECT * FROM graph_edges WHERE id = ?`).get(edgeId) as EdgeRow;
    return this.success(this.rowToEdge(row));
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    await this.initialize();
    const db = this.ensureDb();
    db.prepare(`DELETE FROM graph_edges WHERE id = ?`).run(edgeId);
    return this.success(undefined);
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    await this.initialize();
    const db = this.ensureDb();

    let sql = `SELECT * FROM graph_edges WHERE agent_id = ?`;
    const params: unknown[] = [query.agentId];

    if (query.sourceNodeId) {
      sql += ` AND source_node_id = ?`;
      params.push(query.sourceNodeId);
    }
    if (query.targetNodeId) {
      sql += ` AND target_node_id = ?`;
      params.push(query.targetNodeId);
    }
    if (query.types && query.types.length > 0) {
      const placeholders = query.types.map(() => '?').join(', ');
      sql += ` AND type IN (${placeholders})`;
      params.push(...query.types);
    }
    if (query.minWeight !== undefined) {
      sql += ` AND weight >= ?`;
      params.push(query.minWeight);
    }
    if (query.minConfidence !== undefined) {
      sql += ` AND confidence >= ?`;
      params.push(query.minConfidence);
    }
    if (query.bidirectionalOnly) {
      sql += ' AND bidirectional = 1';
    }

    sql += ' ORDER BY weight DESC, confidence DESC';

    if (query.limit) {
      sql += ` LIMIT ?`;
      params.push(query.limit);
    }

    const rows = db.prepare(sql).all(...params) as EdgeRow[];
    return this.success(rows.map((row) => this.rowToEdge(row)));
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
    _agentId: string,
    startNodeId: string,
    endNodeId: string,
    maxDepth = 5
  ): Promise<MemoryResult<GraphPath | null>> {
    await this.initialize();

    if (startNodeId === endNodeId) {
      const nodeResult = await this.getNode(startNodeId);
      if (!nodeResult.success || !nodeResult.data) return this.success(null);
      return this.success({
        nodes: [nodeResult.data],
        edges: [],
        totalWeight: 0,
        length: 0,
      });
    }

    const queue: {
      nodeId: string;
      pathNodeIds: string[];
      pathEdgeIds: string[];
      totalWeight: number;
    }[] = [{ nodeId: startNodeId, pathNodeIds: [startNodeId], pathEdgeIds: [], totalWeight: 0 }];
    const visited = new Set<string>([startNodeId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.pathEdgeIds.length >= maxDepth) continue;

      const neighborsResult = await this.getNeighbors(current.nodeId, 'both');
      if (!neighborsResult.success) continue;

      for (const { node, edge } of neighborsResult.data) {
        if (visited.has(node.id)) continue;

        const newPath = {
          nodeId: node.id,
          pathNodeIds: [...current.pathNodeIds, node.id],
          pathEdgeIds: [...current.pathEdgeIds, edge.id],
          totalWeight: current.totalWeight + edge.weight,
        };

        if (node.id === endNodeId) {
          const nodes: GraphNode[] = [];
          for (const nid of newPath.pathNodeIds) {
            const nr = await this.getNode(nid);
            if (nr.success && nr.data) nodes.push(nr.data);
          }
          const edges: GraphEdge[] = [];
          for (const eid of newPath.pathEdgeIds) {
            const er = await this.getEdge(eid);
            if (er.success && er.data) edges.push(er.data);
          }
          return this.success({
            nodes,
            edges,
            totalWeight: newPath.totalWeight,
            length: edges.length,
          });
        }

        visited.add(node.id);
        queue.push(newPath);
      }
    }

    return this.success(null);
  }

  async getNeighbors(
    nodeId: string,
    direction: TraversalDirection = 'both'
  ): Promise<MemoryResult<{ node: GraphNode; edge: GraphEdge }[]>> {
    await this.initialize();
    const db = this.ensureDb();

    const selectCols = `
      n.id, n.agent_id, n.type, n.name, n.aliases, n.description,
      n.properties, n.embedding, n.confidence, n.source, n.metadata,
      n.created_at, n.updated_at, n.last_accessed_at, n.access_count,
      e.id as edge_id, e.agent_id as edge_agent_id, e.type as edge_type,
      e.source_node_id as edge_source_node_id, e.target_node_id as edge_target_node_id,
      e.label as edge_label, e.weight as edge_weight, e.bidirectional as edge_bidirectional,
      e.properties as edge_properties, e.confidence as edge_confidence,
      e.source as edge_source, e.valid_from as edge_valid_from, e.valid_until as edge_valid_until,
      e.metadata as edge_metadata, e.created_at as edge_created_at, e.updated_at as edge_updated_at
    `;

    let sql: string;

    if (direction === 'outgoing') {
      sql = `
        SELECT ${selectCols}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.target_node_id
        WHERE e.source_node_id = ?
        UNION ALL
        SELECT ${selectCols}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.source_node_id
        WHERE e.target_node_id = ? AND e.bidirectional = 1
      `;
    } else if (direction === 'incoming') {
      sql = `
        SELECT ${selectCols}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.source_node_id
        WHERE e.target_node_id = ?
        UNION ALL
        SELECT ${selectCols}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.target_node_id
        WHERE e.source_node_id = ? AND e.bidirectional = 1
      `;
    } else {
      sql = `
        SELECT ${selectCols}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.target_node_id
        WHERE e.source_node_id = ?
        UNION ALL
        SELECT ${selectCols}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.source_node_id
        WHERE e.target_node_id = ?
      `;
    }

    const rows = db.prepare(sql).all(nodeId, nodeId) as NeighborRow[];

    return this.success(
      rows.map((row) => ({
        node: this.rowToNode(row as unknown as NodeRow),
        edge: this.neighborRowToEdge(row),
      }))
    );
  }

  async mergeNodes(
    targetNodeId: string,
    sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    await this.initialize();
    const db = this.ensureDb();

    for (const sourceId of sourceNodeIds) {
      const sourceNode = await this.getNode(sourceId);

      db.prepare(`UPDATE graph_edges SET source_node_id = ? WHERE source_node_id = ?`).run(
        targetNodeId,
        sourceId
      );
      db.prepare(`UPDATE graph_edges SET target_node_id = ? WHERE target_node_id = ?`).run(
        targetNodeId,
        sourceId
      );

      db.prepare(`DELETE FROM graph_edges WHERE source_node_id = target_node_id`).run();

      if (sourceNode.success && sourceNode.data) {
        const targetRow = db
          .prepare(`SELECT aliases FROM graph_nodes WHERE id = ?`)
          .get(targetNodeId) as { aliases: string } | undefined;

        if (targetRow) {
          const currentAliases = JSON.parse(targetRow.aliases) as string[];
          const newAliases = [...currentAliases, sourceNode.data.name, ...sourceNode.data.aliases];
          const uniqueAliases = [...new Set(newAliases)];

          db.prepare(`UPDATE graph_nodes SET aliases = ? WHERE id = ?`).run(
            JSON.stringify(uniqueAliases),
            targetNodeId
          );
        }
      }

      db.prepare(`DELETE FROM graph_nodes WHERE id = ?`).run(sourceId);
    }

    const mergedNode = await this.getNode(targetNodeId);
    if (!mergedNode.success || !mergedNode.data) {
      return this.failure(`Target node not found: ${targetNodeId}`);
    }

    return this.success(mergedNode.data);
  }

  async clearGraph(agentId: string): Promise<MemoryResult<void>> {
    await this.initialize();
    const db = this.ensureDb();
    db.prepare(`DELETE FROM graph_edges WHERE agent_id = ?`).run(agentId);
    db.prepare(`DELETE FROM graph_nodes WHERE agent_id = ?`).run(agentId);
    return this.success(undefined);
  }

  async getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>> {
    await this.initialize();
    const db = this.ensureDb();

    const nodeCountRow = db
      .prepare(`SELECT COUNT(*) as count FROM graph_nodes WHERE agent_id = ?`)
      .get(agentId) as { count: number };

    const edgeCountRow = db
      .prepare(`SELECT COUNT(*) as count FROM graph_edges WHERE agent_id = ?`)
      .get(agentId) as { count: number };

    const nodesByTypeRows = db
      .prepare(`SELECT type, COUNT(*) as count FROM graph_nodes WHERE agent_id = ? GROUP BY type`)
      .all(agentId) as { type: string; count: number }[];

    const edgesByTypeRows = db
      .prepare(`SELECT type, COUNT(*) as count FROM graph_edges WHERE agent_id = ? GROUP BY type`)
      .all(agentId) as { type: string; count: number }[];

    const nodeCount = nodeCountRow.count;
    const edgeCount = edgeCountRow.count;

    const nodesByType: Record<string, number> = {};
    for (const row of nodesByTypeRows) {
      nodesByType[row.type] = row.count;
    }

    const edgesByType: Record<string, number> = {};
    for (const row of edgesByTypeRows) {
      edgesByType[row.type] = row.count;
    }

    return this.success({
      nodeCount,
      edgeCount,
      nodesByType: nodesByType as Partial<Record<EntityType, number>>,
      edgesByType: edgesByType as Partial<Record<RelationType, number>>,
      averageEdgesPerNode: nodeCount > 0 ? edgeCount / nodeCount : 0,
      maxDepth: 0,
    });
  }
}
