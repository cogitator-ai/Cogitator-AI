import type {
  CausalGraph,
  CausalGraphData,
  CausalNode,
  CausalEdge,
  CausalPath,
  TripleType,
} from '@cogitator-ai/types';

export class CausalGraphImpl implements CausalGraph {
  readonly id: string;
  readonly name: string;

  private nodes = new Map<string, CausalNode>();
  private edges = new Map<string, CausalEdge>();
  private parentMap = new Map<string, Set<string>>();
  private childMap = new Map<string, Set<string>>();
  private edgeIndex = new Map<string, string>();
  private createdAt: number;
  private updatedAt: number;
  private version: number;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.version = 1;
  }

  static fromData(data: CausalGraphData): CausalGraphImpl {
    const graph = new CausalGraphImpl(data.id, data.name);
    graph.createdAt = data.createdAt;
    graph.updatedAt = data.updatedAt;
    graph.version = data.version;

    for (const node of data.nodes) {
      graph.addNode(node);
    }
    for (const edge of data.edges) {
      graph.addEdge(edge);
    }
    return graph;
  }

  addNode(node: CausalNode): void {
    if (this.nodes.has(node.id)) {
      throw new Error(`Node ${node.id} already exists`);
    }
    this.nodes.set(node.id, { ...node });
    this.parentMap.set(node.id, new Set());
    this.childMap.set(node.id, new Set());
    this.touch();
  }

  removeNode(nodeId: string): void {
    if (!this.nodes.has(nodeId)) return;

    const edgesToRemove: string[] = [];
    for (const [edgeId, edge] of this.edges) {
      if (edge.source === nodeId || edge.target === nodeId) {
        edgesToRemove.push(edgeId);
      }
    }
    for (const edgeId of edgesToRemove) {
      this.removeEdge(edgeId);
    }

    this.nodes.delete(nodeId);
    this.parentMap.delete(nodeId);
    this.childMap.delete(nodeId);
    this.touch();
  }

  getNode(nodeId: string): CausalNode | undefined {
    const node = this.nodes.get(nodeId);
    return node ? { ...node } : undefined;
  }

  getNodes(): CausalNode[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
  }

  hasNode(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  addEdge(edge: CausalEdge): void {
    if (edge.source === edge.target) {
      throw new Error(`Self-loop not allowed: ${edge.source}`);
    }
    if (this.edges.has(edge.id)) {
      throw new Error(`Edge ${edge.id} already exists`);
    }
    if (!this.nodes.has(edge.source)) {
      throw new Error(`Source node ${edge.source} does not exist`);
    }
    if (!this.nodes.has(edge.target)) {
      throw new Error(`Target node ${edge.target} does not exist`);
    }

    const indexKey = `${edge.source}:${edge.target}`;
    if (this.edgeIndex.has(indexKey)) {
      throw new Error(`Edge from ${edge.source} to ${edge.target} already exists`);
    }

    this.edges.set(edge.id, { ...edge });
    this.edgeIndex.set(indexKey, edge.id);
    this.childMap.get(edge.source)!.add(edge.target);
    this.parentMap.get(edge.target)!.add(edge.source);
    this.touch();
  }

  removeEdge(edgeId: string): void {
    const edge = this.edges.get(edgeId);
    if (!edge) return;

    const indexKey = `${edge.source}:${edge.target}`;
    this.edgeIndex.delete(indexKey);
    this.childMap.get(edge.source)?.delete(edge.target);
    this.parentMap.get(edge.target)?.delete(edge.source);
    this.edges.delete(edgeId);
    this.touch();
  }

  getEdge(edgeId: string): CausalEdge | undefined {
    const edge = this.edges.get(edgeId);
    return edge ? { ...edge } : undefined;
  }

  getEdges(): CausalEdge[] {
    return Array.from(this.edges.values()).map((e) => ({ ...e }));
  }

  getEdgeBetween(source: string, target: string): CausalEdge | undefined {
    const edgeId = this.edgeIndex.get(`${source}:${target}`);
    return edgeId ? this.getEdge(edgeId) : undefined;
  }

  getParents(nodeId: string): CausalNode[] {
    const parentIds = this.parentMap.get(nodeId);
    if (!parentIds) return [];
    return Array.from(parentIds)
      .map((id) => this.getNode(id))
      .filter((n): n is CausalNode => n !== undefined);
  }

  getChildren(nodeId: string): CausalNode[] {
    const childIds = this.childMap.get(nodeId);
    if (!childIds) return [];
    return Array.from(childIds)
      .map((id) => this.getNode(id))
      .filter((n): n is CausalNode => n !== undefined);
  }

  getAncestors(nodeId: string): CausalNode[] {
    const ancestors = new Set<string>();
    const queue = [...(this.parentMap.get(nodeId) || [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (ancestors.has(current)) continue;
      ancestors.add(current);
      const parents = this.parentMap.get(current);
      if (parents) {
        for (const parent of parents) {
          if (!ancestors.has(parent)) {
            queue.push(parent);
          }
        }
      }
    }

    return Array.from(ancestors)
      .map((id) => this.getNode(id))
      .filter((n): n is CausalNode => n !== undefined);
  }

  getDescendants(nodeId: string): CausalNode[] {
    const descendants = new Set<string>();
    const queue = [...(this.childMap.get(nodeId) || [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (descendants.has(current)) continue;
      descendants.add(current);
      const children = this.childMap.get(current);
      if (children) {
        for (const child of children) {
          if (!descendants.has(child)) {
            queue.push(child);
          }
        }
      }
    }

    return Array.from(descendants)
      .map((id) => this.getNode(id))
      .filter((n): n is CausalNode => n !== undefined);
  }

  findPaths(from: string, to: string, maxLength = 10): CausalPath[] {
    const paths: CausalPath[] = [];
    const visited = new Set<string>();

    const dfs = (
      current: string,
      target: string,
      path: string[],
      edges: CausalEdge[],
      depth: number
    ) => {
      if (depth > maxLength) return;
      if (current === target) {
        paths.push({
          nodes: [...path],
          edges: [...edges],
          totalStrength: edges.reduce((acc, e) => acc * e.strength, 1),
          isBlocked: false,
          blockingNodes: [],
        });
        return;
      }

      visited.add(current);
      const children = this.childMap.get(current);
      if (children) {
        for (const child of children) {
          if (!visited.has(child)) {
            const edge = this.getEdgeBetween(current, child);
            if (edge) {
              dfs(child, target, [...path, child], [...edges, edge], depth + 1);
            }
          }
        }
      }
      visited.delete(current);
    };

    dfs(from, to, [from], [], 0);
    return paths;
  }

  getMarkovBlanket(nodeId: string): CausalNode[] {
    const blanket = new Set<string>();

    const parents = this.parentMap.get(nodeId);
    if (parents) {
      for (const p of parents) blanket.add(p);
    }

    const children = this.childMap.get(nodeId);
    if (children) {
      for (const c of children) {
        blanket.add(c);
        const coparents = this.parentMap.get(c);
        if (coparents) {
          for (const cp of coparents) {
            if (cp !== nodeId) blanket.add(cp);
          }
        }
      }
    }

    return Array.from(blanket)
      .map((id) => this.getNode(id))
      .filter((n): n is CausalNode => n !== undefined);
  }

  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const nodeId of this.nodes.keys()) {
      inDegree.set(nodeId, 0);
    }
    for (const edge of this.edges.values()) {
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) queue.push(nodeId);
    }

    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const children = this.childMap.get(current);
      if (children) {
        for (const child of children) {
          const newDegree = (inDegree.get(child) || 0) - 1;
          inDegree.set(child, newDegree);
          if (newDegree === 0) queue.push(child);
        }
      }
    }

    if (result.length !== this.nodes.size) {
      throw new Error('Graph contains a cycle');
    }

    return result;
  }

  hasCycle(): boolean {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const hasCycleDFS = (nodeId: string): boolean => {
      visited.add(nodeId);
      recStack.add(nodeId);

      const children = this.childMap.get(nodeId);
      if (children) {
        for (const child of children) {
          if (!visited.has(child)) {
            if (hasCycleDFS(child)) return true;
          } else if (recStack.has(child)) {
            return true;
          }
        }
      }

      recStack.delete(nodeId);
      return false;
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        if (hasCycleDFS(nodeId)) return true;
      }
    }

    return false;
  }

  clone(): CausalGraph {
    return CausalGraphImpl.fromData(this.toData());
  }

  toData(): CausalGraphData {
    return {
      id: this.id,
      name: this.name,
      nodes: this.getNodes(),
      edges: this.getEdges(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      version: this.version,
    };
  }

  private touch(): void {
    this.updatedAt = Date.now();
    this.version++;
  }
}

export function getTripleType(
  graph: CausalGraph,
  a: string,
  b: string,
  c: string
): TripleType | null {
  const abEdge = graph.getEdgeBetween(a, b);
  const baEdge = graph.getEdgeBetween(b, a);
  const bcEdge = graph.getEdgeBetween(b, c);
  const cbEdge = graph.getEdgeBetween(c, b);

  if (abEdge && bcEdge) {
    return 'chain';
  }
  if (baEdge && bcEdge) {
    return 'fork';
  }
  if (abEdge && cbEdge) {
    return 'collider';
  }

  return null;
}
