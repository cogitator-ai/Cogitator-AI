import type { CausalGraph, CausalPath, DSeparationResult, TripleType } from '@cogitator-ai/types';

export function dSeparation(
  graph: CausalGraph,
  x: string | string[],
  y: string | string[],
  z: string[] = []
): DSeparationResult {
  const xSet = new Set(Array.isArray(x) ? x : [x]);
  const ySet = new Set(Array.isArray(y) ? y : [y]);
  const zSet = new Set(z);

  const allPaths: CausalPath[] = [];

  for (const xNode of xSet) {
    for (const yNode of ySet) {
      const paths = findAllUndirectedPaths(graph, xNode, yNode);
      allPaths.push(...paths);
    }
  }

  const blockedPaths: CausalPath[] = [];
  const openPaths: CausalPath[] = [];

  for (const path of allPaths) {
    const blockResult = isPathBlocked(graph, path, zSet);
    if (blockResult.blocked) {
      path.isBlocked = true;
      path.blockingNodes = blockResult.blockingNodes;
      blockedPaths.push(path);
    } else {
      openPaths.push(path);
    }
  }

  return {
    separated: openPaths.length === 0,
    paths: allPaths,
    blockedPaths,
    openPaths,
  };
}

function findAllUndirectedPaths(
  graph: CausalGraph,
  from: string,
  to: string,
  maxLength = 10
): CausalPath[] {
  const paths: CausalPath[] = [];
  const visited = new Set<string>();

  const dfs = (current: string, path: string[], depth: number) => {
    if (depth > maxLength) return;
    if (current === to && path.length > 1) {
      paths.push({
        nodes: [...path],
        edges: [],
        totalStrength: 1,
        isBlocked: false,
        blockingNodes: [],
      });
      return;
    }

    visited.add(current);

    const neighbors = new Set<string>();
    for (const parent of graph.getParents(current)) {
      neighbors.add(parent.id);
    }
    for (const child of graph.getChildren(current)) {
      neighbors.add(child.id);
    }

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path, neighbor], depth + 1);
      }
    }

    visited.delete(current);
  };

  dfs(from, [from], 0);
  return paths;
}

function isPathBlocked(
  graph: CausalGraph,
  path: CausalPath,
  conditioningSet: Set<string>
): { blocked: boolean; blockingNodes: string[] } {
  if (path.nodes.length < 3) return { blocked: false, blockingNodes: [] };

  const blockingNodes: string[] = [];

  for (let i = 1; i < path.nodes.length - 1; i++) {
    const prev = path.nodes[i - 1];
    const curr = path.nodes[i];
    const next = path.nodes[i + 1];

    if (isTripleBlocked(graph, prev, curr, next, conditioningSet)) {
      blockingNodes.push(curr);
    }
  }

  return { blocked: blockingNodes.length > 0, blockingNodes };
}

function getLocalTripleType(graph: CausalGraph, a: string, b: string, c: string): TripleType {
  const aToB = graph.getEdgeBetween(a, b) !== undefined;
  const bToA = graph.getEdgeBetween(b, a) !== undefined;
  const bToC = graph.getEdgeBetween(b, c) !== undefined;
  const cToB = graph.getEdgeBetween(c, b) !== undefined;

  if ((aToB && bToC) || (cToB && bToA)) {
    return 'chain';
  }
  if (bToA && bToC) {
    return 'fork';
  }
  if (aToB && cToB) {
    return 'collider';
  }

  if (aToB || bToA) {
    if (bToC || cToB) {
      return 'chain';
    }
  }

  return 'chain';
}

function isColliderOrDescendantInSet(
  graph: CausalGraph,
  nodeId: string,
  conditioningSet: Set<string>
): boolean {
  if (conditioningSet.has(nodeId)) return true;

  const descendants = graph.getDescendants(nodeId);
  for (const desc of descendants) {
    if (conditioningSet.has(desc.id)) return true;
  }

  return false;
}

function isTripleBlocked(
  graph: CausalGraph,
  prev: string,
  curr: string,
  next: string,
  conditioningSet: Set<string>
): boolean {
  const tripleType = getLocalTripleType(graph, prev, curr, next);

  if (tripleType === 'chain' || tripleType === 'fork') {
    return conditioningSet.has(curr);
  }

  if (tripleType === 'collider') {
    return !isColliderOrDescendantInSet(graph, curr, conditioningSet);
  }

  return false;
}

export function findMinimalSeparatingSet(
  graph: CausalGraph,
  x: string | string[],
  y: string | string[],
  forbidden = new Set<string>()
): string[] | null {
  const xSet = new Set(Array.isArray(x) ? x : [x]);
  const ySet = new Set(Array.isArray(y) ? y : [y]);

  const allNodes = graph.getNodes().map((n) => n.id);
  const candidates = allNodes.filter((n) => !xSet.has(n) && !ySet.has(n) && !forbidden.has(n));

  for (let size = 0; size <= candidates.length; size++) {
    for (const subset of combinations(candidates, size)) {
      const result = dSeparation(graph, x, y, subset);
      if (result.separated) {
        return subset;
      }
    }
  }

  return null;
}

function* combinations<T>(arr: T[], size: number): Generator<T[]> {
  if (size === 0) {
    yield [];
    return;
  }
  if (arr.length < size) return;

  for (let i = 0; i <= arr.length - size; i++) {
    for (const rest of combinations(arr.slice(i + 1), size - 1)) {
      yield [arr[i], ...rest];
    }
  }
}
