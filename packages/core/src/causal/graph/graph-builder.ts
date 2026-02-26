import type {
  CausalNode,
  CausalEdge,
  CausalGraph,
  CausalRelationType,
  VariableType,
  StructuralEquation,
} from '@cogitator-ai/types';
import { CausalGraphImpl } from './causal-graph';
import { nanoid } from 'nanoid';

export class CausalGraphBuilder {
  private graphId: string;
  private graphName: string;
  private nodes = new Map<string, CausalNode>();
  private pendingEdges: Array<Omit<CausalEdge, 'id'>> = [];
  private currentNode: string | null = null;

  private constructor(id: string, name: string) {
    this.graphId = id;
    this.graphName = name;
  }

  static create(name: string, id?: string): CausalGraphBuilder {
    return new CausalGraphBuilder(
      id || `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name
    );
  }

  variable(id: string, name: string, type: VariableType = 'observed'): CausalGraphBuilder {
    this.nodes.set(id, {
      id,
      name,
      variableType: type,
    });
    this.currentNode = id;
    return this;
  }

  treatment(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'treatment');
  }

  outcome(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'outcome');
  }

  confounder(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'confounder');
  }

  mediator(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'mediator');
  }

  instrumental(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'instrumental');
  }

  collider(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'collider');
  }

  latent(id: string, name: string): CausalGraphBuilder {
    return this.variable(id, name, 'latent');
  }

  withDomain(
    type: 'continuous' | 'discrete' | 'binary' | 'categorical',
    options?: { values?: (string | number | boolean)[]; min?: number; max?: number }
  ): CausalGraphBuilder {
    if (!this.currentNode) {
      throw new Error('No current node to set domain on');
    }
    const node = this.nodes.get(this.currentNode)!;
    node.domain = { type, ...options };
    return this;
  }

  withEquation(equation: StructuralEquation): CausalGraphBuilder {
    if (!this.currentNode) {
      throw new Error('No current node to set equation on');
    }
    const node = this.nodes.get(this.currentNode)!;
    node.equation = equation;
    return this;
  }

  causes(
    target: string,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    return this.edge(target, 'causes', options);
  }

  enables(
    target: string,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    return this.edge(target, 'enables', options);
  }

  prevents(
    target: string,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    return this.edge(target, 'prevents', options);
  }

  mediates(
    target: string,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    return this.edge(target, 'mediates', options);
  }

  confounds(
    target: string,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    return this.edge(target, 'confounds', options);
  }

  moderates(
    target: string,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    return this.edge(target, 'moderates', options);
  }

  edge(
    target: string,
    relationType: CausalRelationType,
    options?: { strength?: number; confidence?: number; mechanism?: string; timelag?: number }
  ): CausalGraphBuilder {
    if (!this.currentNode) {
      throw new Error('No current node to create edge from');
    }
    this.pendingEdges.push({
      source: this.currentNode,
      target,
      relationType,
      strength: options?.strength ?? 1.0,
      confidence: options?.confidence ?? 1.0,
      mechanism: options?.mechanism,
      timelag: options?.timelag,
    });
    return this;
  }

  from(nodeId: string): CausalGraphBuilder {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node ${nodeId} does not exist`);
    }
    this.currentNode = nodeId;
    return this;
  }

  connect(
    source: string,
    target: string,
    relationType: CausalRelationType,
    options?: { strength?: number; confidence?: number; mechanism?: string }
  ): CausalGraphBuilder {
    this.pendingEdges.push({
      source,
      target,
      relationType,
      strength: options?.strength ?? 1.0,
      confidence: options?.confidence ?? 1.0,
      mechanism: options?.mechanism,
    });
    return this;
  }

  build(): CausalGraph {
    const graph = new CausalGraphImpl(this.graphId, this.graphName);

    for (const node of this.nodes.values()) {
      graph.addNode(node);
    }

    for (const edgeData of this.pendingEdges) {
      const edge: CausalEdge = {
        id: `edge-${nanoid(8)}`,
        ...edgeData,
      };
      graph.addEdge(edge);
    }

    return graph;
  }
}
