import { requireEnv, header, section } from '../_shared/setup.js';
import { createLLMBackend } from '@cogitator-ai/core';
import { LLMEntityExtractor, GraphInferenceEngine } from '@cogitator-ai/memory';
import type {
  ExtractedEntity,
  ExtractedRelation,
  GraphAdapter,
  GraphNode,
  GraphEdge,
  MemoryResult,
  NodeQuery,
  EdgeQuery,
  TraversalOptions,
  TraversalResult,
  GraphPath,
  GraphSemanticSearchOptions,
  GraphStats,
  EntityType,
  RelationType,
  TraversalDirection,
} from '@cogitator-ai/types';
let _idCounter = 0;
function genId(prefix: string) {
  return `${prefix}_${++_idCounter}_${Date.now().toString(36)}`;
}

const paragraphs = [
  `Marie Curie was a Polish-born physicist and chemist who conducted pioneering research on radioactivity.
She was the first woman to win a Nobel Prize, and the only person to win Nobel Prizes in two different sciences.
She worked at the University of Paris where she became the first female professor.`,

  `Pierre Curie was a French physicist and husband of Marie Curie. Together they discovered polonium and radium.
Pierre was appointed professor at the University of Paris in 1900. He shared the 1903 Nobel Prize in Physics
with Marie and Henri Becquerel for their research on radiation.`,

  `Henri Becquerel was a French physicist who discovered radioactivity in 1896, for which he shared the Nobel Prize
in Physics with Pierre and Marie Curie. He was a professor at the Museum of Natural History in Paris
and also taught at the Ecole Polytechnique.`,

  `Irene Joliot-Curie was the daughter of Marie and Pierre Curie. She won the 1935 Nobel Prize in Chemistry
together with her husband Frederic Joliot-Curie for their discovery of artificial radioactivity.
She worked at the Radium Institute in Paris, which was founded by her mother.`,
];

class InMemoryGraphAdapter implements GraphAdapter {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  private ok<T>(data: T): MemoryResult<T> {
    return { success: true, data };
  }

  async addNode(
    node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt' | 'lastAccessedAt' | 'accessCount'>
  ): Promise<MemoryResult<GraphNode>> {
    const now = new Date();
    const full: GraphNode = {
      ...node,
      id: genId('node'),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    };
    this.nodes.set(full.id, full);
    return this.ok(full);
  }

  async getNode(nodeId: string): Promise<MemoryResult<GraphNode | null>> {
    return this.ok(this.nodes.get(nodeId) ?? null);
  }

  async getNodeByName(agentId: string, name: string): Promise<MemoryResult<GraphNode | null>> {
    for (const node of this.nodes.values()) {
      if (node.agentId === agentId && node.name.toLowerCase() === name.toLowerCase()) {
        return this.ok(node);
      }
    }
    return this.ok(null);
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
    if (!node) return { success: false, error: 'not found' };
    Object.assign(node, updates, { updatedAt: new Date() });
    return this.ok(node);
  }

  async deleteNode(nodeId: string): Promise<MemoryResult<void>> {
    this.nodes.delete(nodeId);
    for (const [id, edge] of this.edges) {
      if (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId) {
        this.edges.delete(id);
      }
    }
    return this.ok(undefined);
  }

  async queryNodes(query: NodeQuery): Promise<MemoryResult<GraphNode[]>> {
    const results: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.agentId !== query.agentId) continue;
      if (query.types && !query.types.includes(node.type)) continue;
      if (query.namePattern && !node.name.toLowerCase().includes(query.namePattern.toLowerCase()))
        continue;
      if (query.minConfidence !== undefined && node.confidence < query.minConfidence) continue;
      results.push(node);
    }
    return this.ok(query.limit ? results.slice(0, query.limit) : results);
  }

  async searchNodesSemantic(
    _options: GraphSemanticSearchOptions
  ): Promise<MemoryResult<(GraphNode & { score: number })[]>> {
    return this.ok([]);
  }

  async addEdge(
    edge: Omit<GraphEdge, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<MemoryResult<GraphEdge>> {
    const now = new Date();
    const full: GraphEdge = { ...edge, id: genId('edge'), createdAt: now, updatedAt: now };
    this.edges.set(full.id, full);
    return this.ok(full);
  }

  async getEdge(edgeId: string): Promise<MemoryResult<GraphEdge | null>> {
    return this.ok(this.edges.get(edgeId) ?? null);
  }

  async getEdgesBetween(
    sourceNodeId: string,
    targetNodeId: string
  ): Promise<MemoryResult<GraphEdge[]>> {
    const results: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      if (
        (edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId) ||
        (edge.bidirectional &&
          edge.sourceNodeId === targetNodeId &&
          edge.targetNodeId === sourceNodeId)
      ) {
        results.push(edge);
      }
    }
    return this.ok(results);
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
    if (!edge) return { success: false, error: 'not found' };
    Object.assign(edge, updates, { updatedAt: new Date() });
    return this.ok(edge);
  }

  async deleteEdge(edgeId: string): Promise<MemoryResult<void>> {
    this.edges.delete(edgeId);
    return this.ok(undefined);
  }

  async queryEdges(query: EdgeQuery): Promise<MemoryResult<GraphEdge[]>> {
    const results: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      if (edge.agentId !== query.agentId) continue;
      if (query.sourceNodeId && edge.sourceNodeId !== query.sourceNodeId) continue;
      if (query.targetNodeId && edge.targetNodeId !== query.targetNodeId) continue;
      if (query.types && !query.types.includes(edge.type)) continue;
      if (query.minWeight !== undefined && edge.weight < query.minWeight) continue;
      if (query.minConfidence !== undefined && edge.confidence < query.minConfidence) continue;
      results.push(edge);
    }
    return this.ok(query.limit ? results.slice(0, query.limit) : results);
  }

  async traverse(options: TraversalOptions): Promise<MemoryResult<TraversalResult>> {
    const visited = new Set<string>();
    const visitedEdges = new Set<string>();
    const paths: GraphPath[] = [];
    const allNodes: GraphNode[] = [];
    const allEdges: GraphEdge[] = [];

    const startNode = this.nodes.get(options.startNodeId);
    if (!startNode) return { success: false, error: 'Start node not found' };

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

    return this.ok({
      paths,
      visitedNodes: allNodes,
      visitedEdges: allEdges,
      depth: options.maxDepth,
    });
  }

  private async traverseRecursive(
    current: GraphNode,
    pathNodes: GraphNode[],
    pathEdges: GraphEdge[],
    depth: number,
    options: TraversalOptions,
    visited: Set<string>,
    visitedEdges: Set<string>,
    paths: GraphPath[],
    allNodes: GraphNode[],
    allEdges: GraphEdge[]
  ): Promise<void> {
    if (depth >= options.maxDepth) {
      if (pathNodes.length > 0) {
        paths.push({
          nodes: [...pathNodes, current],
          edges: [...pathEdges],
          totalWeight: pathEdges.reduce((sum, e) => sum + e.weight, 0),
          length: pathEdges.length,
        });
      }
      return;
    }

    const neighbors = this.getNeighborEdges(current.id, options.direction ?? 'both');
    for (const edge of neighbors) {
      if (options.edgeTypes && !options.edgeTypes.includes(edge.type)) continue;
      const neighborId = edge.sourceNodeId === current.id ? edge.targetNodeId : edge.sourceNodeId;

      if (!visitedEdges.has(edge.id)) {
        visitedEdges.add(edge.id);
        allEdges.push(edge);
      }

      if (!visited.has(neighborId)) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        visited.add(neighborId);
        allNodes.push(neighbor);

        await this.traverseRecursive(
          neighbor,
          [...pathNodes, current],
          [...pathEdges, edge],
          depth + 1,
          options,
          visited,
          visitedEdges,
          paths,
          allNodes,
          allEdges
        );
      }
    }
  }

  private getNeighborEdges(nodeId: string, direction: TraversalDirection): GraphEdge[] {
    const results: GraphEdge[] = [];
    for (const edge of this.edges.values()) {
      if (direction === 'outgoing' && edge.sourceNodeId === nodeId) results.push(edge);
      else if (direction === 'incoming' && edge.targetNodeId === nodeId) results.push(edge);
      else if (
        direction === 'both' &&
        (edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
      )
        results.push(edge);
    }
    return results;
  }

  async findShortestPath(
    _agentId: string,
    _startNodeId: string,
    _endNodeId: string,
    _maxDepth?: number
  ): Promise<MemoryResult<GraphPath | null>> {
    return this.ok(null);
  }

  async getNeighbors(
    nodeId: string,
    direction?: TraversalDirection
  ): Promise<MemoryResult<{ node: GraphNode; edge: GraphEdge }[]>> {
    const edges = this.getNeighborEdges(nodeId, direction ?? 'both');
    const results: { node: GraphNode; edge: GraphEdge }[] = [];
    for (const edge of edges) {
      const neighborId = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
      const node = this.nodes.get(neighborId);
      if (node) results.push({ node, edge });
    }
    return this.ok(results);
  }

  async mergeNodes(
    _targetNodeId: string,
    _sourceNodeIds: string[]
  ): Promise<MemoryResult<GraphNode>> {
    return { success: false, error: 'not implemented' };
  }

  async clearGraph(agentId: string): Promise<MemoryResult<void>> {
    for (const [id, node] of this.nodes) {
      if (node.agentId === agentId) this.nodes.delete(id);
    }
    for (const [id, edge] of this.edges) {
      if (edge.agentId === agentId) this.edges.delete(id);
    }
    return this.ok(undefined);
  }

  async getGraphStats(agentId: string): Promise<MemoryResult<GraphStats>> {
    let nodeCount = 0;
    let edgeCount = 0;
    const nodesByType: Record<string, number> = {};
    const edgesByType: Record<string, number> = {};

    for (const node of this.nodes.values()) {
      if (node.agentId !== agentId) continue;
      nodeCount++;
      nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    }
    for (const edge of this.edges.values()) {
      if (edge.agentId !== agentId) continue;
      edgeCount++;
      edgesByType[edge.type] = (edgesByType[edge.type] ?? 0) + 1;
    }

    return this.ok({
      nodeCount,
      edgeCount,
      nodesByType: nodesByType as Record<EntityType, number>,
      edgesByType: edgesByType as Record<RelationType, number>,
      averageEdgesPerNode: nodeCount > 0 ? edgeCount / nodeCount : 0,
      maxDepth: 0,
    });
  }
}

async function main() {
  header('04 — Knowledge Graph: Entity Extraction & Graph Traversal');

  requireEnv('GOOGLE_API_KEY');

  const llmBackend = createLLMBackend('google', {
    providers: { google: { apiKey: process.env.GOOGLE_API_KEY } },
  });

  const model = 'gemini-2.5-flash';
  const backend = {
    chat: (opts: {
      messages: Array<{ role: string; content: string }>;
      responseFormat?: unknown;
    }) => llmBackend.chat({ ...opts, model } as Parameters<typeof llmBackend.chat>[0]),
  };

  const extractor = new LLMEntityExtractor(backend, {
    minConfidence: 0.6,
    maxEntitiesPerText: 15,
    maxRelationsPerText: 20,
  });

  section('1. Extract entities from text');

  const allEntities: ExtractedEntity[] = [];
  const allRelations: ExtractedRelation[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    console.log(`Processing paragraph ${i + 1}/${paragraphs.length}...`);
    const result = await extractor.extract(paragraphs[i], {
      existingEntities: allEntities.map((e) => e.name),
    });

    console.log(`  Entities: ${result.entities.map((e) => `${e.name} (${e.type})`).join(', ')}`);
    console.log(
      `  Relations: ${result.relations.map((r) => `${r.sourceEntity} → ${r.type} → ${r.targetEntity}`).join(', ')}`
    );

    allEntities.push(...result.entities);
    allRelations.push(...result.relations);
  }

  const uniqueEntities = new Map<string, ExtractedEntity>();
  for (const entity of allEntities) {
    const key = entity.name.toLowerCase();
    const existing = uniqueEntities.get(key);
    if (!existing || entity.confidence > existing.confidence) {
      uniqueEntities.set(key, entity);
    }
  }

  console.log(`\nTotal unique entities: ${uniqueEntities.size}`);
  console.log(`Total relations: ${allRelations.length}`);

  section('2. Build knowledge graph');

  const graph = new InMemoryGraphAdapter();
  const agentId = 'kg-agent';

  const nodeMap = new Map<string, GraphNode>();

  for (const entity of uniqueEntities.values()) {
    const result = await graph.addNode({
      agentId,
      type: entity.type,
      name: entity.name,
      aliases: entity.aliases ?? [],
      description: entity.description,
      properties: {},
      confidence: entity.confidence,
      source: 'extracted',
    });
    nodeMap.set(entity.name.toLowerCase(), result.data!);
  }

  let edgesCreated = 0;
  for (const relation of allRelations) {
    const sourceNode = nodeMap.get(relation.sourceEntity.toLowerCase());
    const targetNode = nodeMap.get(relation.targetEntity.toLowerCase());
    if (!sourceNode || !targetNode) continue;

    await graph.addEdge({
      agentId,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      type: relation.type,
      label: relation.label,
      weight: 1.0,
      bidirectional: false,
      properties: {},
      confidence: relation.confidence,
      source: 'extracted',
    });
    edgesCreated++;
  }

  const stats = await graph.getGraphStats(agentId);
  console.log('Graph stats:');
  console.log(`  Nodes: ${stats.data!.nodeCount}`);
  console.log(`  Edges: ${stats.data!.edgeCount}`);
  console.log(`  Node types:`, stats.data!.nodesByType);
  console.log(`  Edge types:`, stats.data!.edgesByType);
  console.log(`  Avg edges/node: ${stats.data!.averageEdgesPerNode.toFixed(1)}`);

  section('3. Query the graph');

  const people = await graph.queryNodes({ agentId, types: ['person'] });
  console.log('People in the graph:');
  for (const person of people.data!) {
    console.log(`  ${person.name} — ${person.description ?? 'no description'}`);
  }

  const orgs = await graph.queryNodes({ agentId, types: ['organization'] });
  console.log('\nOrganizations:');
  for (const org of orgs.data!) {
    console.log(`  ${org.name} — ${org.description ?? 'no description'}`);
  }

  section('4. Graph traversal');

  const marieNode =
    nodeMap.get('marie curie') ??
    nodeMap.get('marie') ??
    [...nodeMap.values()].find((n) => n.name.toLowerCase().includes('marie'));

  if (marieNode) {
    console.log(`Traversing from: ${marieNode.name}\n`);

    const neighbors = await graph.getNeighbors(marieNode.id);
    console.log('Direct connections:');
    for (const { node, edge } of neighbors.data!) {
      const direction = edge.sourceNodeId === marieNode.id ? '→' : '←';
      console.log(`  ${direction} ${edge.type} ${direction} ${node.name} (${node.type})`);
    }

    const traversal = await graph.traverse({
      agentId,
      startNodeId: marieNode.id,
      maxDepth: 2,
      direction: 'both',
    });

    console.log(`\nMulti-hop traversal (depth=2):`);
    console.log(`  Visited ${traversal.data!.visitedNodes.length} nodes`);
    console.log(`  Visited ${traversal.data!.visitedEdges.length} edges`);
    console.log(`  Reachable: ${traversal.data!.visitedNodes.map((n) => n.name).join(', ')}`);
  }

  section('5. Inference engine');

  const inferenceEngine = new GraphInferenceEngine(graph);

  console.log('Registered rules:');
  for (const rule of inferenceEngine.getRules()) {
    console.log(`  ${rule.name}: ${rule.description}`);
  }

  const inferred = await inferenceEngine.infer(agentId);

  if (inferred.length > 0) {
    console.log(`\nInferred ${inferred.length} new relationships:`);
    for (const edge of inferred) {
      const source = [...nodeMap.values()].find((n) => n.id === edge.sourceNodeId);
      const target = [...nodeMap.values()].find((n) => n.id === edge.targetNodeId);
      console.log(
        `  ${source?.name ?? edge.sourceNodeId} → ${edge.type} → ${target?.name ?? edge.targetNodeId} (confidence: ${edge.confidence.toFixed(2)})`
      );
    }

    const materialized = await inferenceEngine.materialize(inferred);
    console.log(`\nMaterialized ${materialized.data!.length} edges into graph`);

    const updatedStats = await graph.getGraphStats(agentId);
    console.log(
      `Updated graph: ${updatedStats.data!.nodeCount} nodes, ${updatedStats.data!.edgeCount} edges`
    );
  } else {
    console.log('\nNo new relationships inferred (graph may be too sparse or rules do not match).');
  }

  console.log('\nDone.');
}

main();
