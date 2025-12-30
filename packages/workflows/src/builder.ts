/**
 * WorkflowBuilder - Fluent API for constructing workflows
 */

import type {
  Workflow,
  WorkflowNode,
  WorkflowState,
  NodeFn,
  Edge,
  AddNodeOptions,
  AddConditionalOptions,
  AddLoopOptions,
  NodeConfig,
} from '@cogitator/types';

interface InternalNode<S> {
  name: string;
  fn: NodeFn<S>;
  config?: NodeConfig;
  after: string[];
}

interface InternalConditional<S> {
  name: string;
  condition: (state: S) => string | string[];
  after: string[];
}

interface InternalLoop<S> {
  name: string;
  condition: (state: S) => boolean;
  back: string;
  exit: string;
  after: string[];
}

export class WorkflowBuilder<S extends WorkflowState = WorkflowState> {
  private name: string;
  private state: S;
  private nodes: InternalNode<S>[] = [];
  private conditionals: InternalConditional<S>[] = [];
  private loops: InternalLoop<S>[] = [];
  private entryPointName: string | null = null;

  constructor(name: string) {
    this.name = name;
    this.state = {} as S;
  }

  /**
   * Set the initial state for the workflow
   */
  initialState(state: S): this {
    this.state = state;
    return this;
  }

  /**
   * Set explicit entry point (first node to execute)
   */
  entryPoint(nodeName: string): this {
    this.entryPointName = nodeName;
    return this;
  }

  /**
   * Add a node to the workflow
   */
  addNode(name: string, fn: NodeFn<S>, options?: AddNodeOptions): this {
    this.nodes.push({
      name,
      fn,
      config: options?.config,
      after: options?.after ?? [],
    });
    return this;
  }

  /**
   * Add a conditional routing node
   */
  addConditional(
    name: string,
    condition: (state: S) => string | string[],
    options?: AddConditionalOptions
  ): this {
    this.conditionals.push({
      name,
      condition,
      after: options?.after ?? [],
    });
    return this;
  }

  /**
   * Add a loop construct
   */
  addLoop(name: string, options: AddLoopOptions): this {
    this.loops.push({
      name,
      condition: options.condition as (state: S) => boolean,
      back: options.back,
      exit: options.exit,
      after: options.after ?? [],
    });
    return this;
  }

  /**
   * Build and validate the workflow
   */
  build(): Workflow<S> {
    // Create nodes map
    const nodesMap = new Map<string, WorkflowNode<S>>();

    for (const node of this.nodes) {
      nodesMap.set(node.name, {
        name: node.name,
        fn: node.fn,
        config: node.config,
      });
    }

    // Add conditional nodes as pass-through nodes
    for (const cond of this.conditionals) {
      nodesMap.set(cond.name, {
        name: cond.name,
        fn: async (ctx) => ({ output: ctx.state }),
        config: undefined,
      });
    }

    // Add loop nodes as pass-through nodes
    for (const loop of this.loops) {
      nodesMap.set(loop.name, {
        name: loop.name,
        fn: async (ctx) => ({ output: ctx.state }),
        config: undefined,
      });
    }

    // Build edges
    const edges: Edge[] = [];

    // Collect conditional and loop node names (their routing is handled dynamically)
    const conditionalNames = new Set(this.conditionals.map((c) => c.name));
    const loopNames = new Set(this.loops.map((l) => l.name));

    // Sequential edges from 'after' dependencies
    // Skip if dependency is a conditional or loop (those handle routing dynamically)
    for (const node of this.nodes) {
      for (const dep of node.after) {
        if (conditionalNames.has(dep) || loopNames.has(dep)) {
          // Routing from conditionals/loops is handled by their specific edges
          continue;
        }
        edges.push({
          type: 'sequential',
          from: dep,
          to: node.name,
        });
      }
    }

    // Conditional edges
    for (const cond of this.conditionals) {
      // Add dependencies
      for (const dep of cond.after) {
        edges.push({
          type: 'sequential',
          from: dep,
          to: cond.name,
        });
      }

      // Find all possible targets (nodes that have this conditional in their 'after')
      const targets: string[] = [];
      for (const node of this.nodes) {
        if (node.after.includes(cond.name)) {
          targets.push(node.name);
        }
      }

      if (targets.length > 0) {
        edges.push({
          type: 'conditional',
          from: cond.name,
          condition: cond.condition as (state: unknown) => string | string[],
          targets,
        });
      }
    }

    // Loop edges
    for (const loop of this.loops) {
      // Add dependencies
      for (const dep of loop.after) {
        edges.push({
          type: 'sequential',
          from: dep,
          to: loop.name,
        });
      }

      edges.push({
        type: 'loop',
        from: loop.name,
        condition: loop.condition as (state: unknown) => boolean,
        back: loop.back,
        exit: loop.exit,
      });
    }

    // Determine entry point
    let entryPoint = this.entryPointName;

    if (!entryPoint) {
      // Find nodes with no dependencies (roots)
      const allDeps = new Set<string>();
      for (const node of this.nodes) {
        for (const dep of node.after) {
          allDeps.add(dep);
        }
      }
      for (const cond of this.conditionals) {
        for (const dep of cond.after) {
          allDeps.add(dep);
        }
      }

      const roots: string[] = [];
      for (const node of this.nodes) {
        if (node.after.length === 0 && !allDeps.has(node.name)) {
          roots.push(node.name);
        }
      }

      if (roots.length === 0) {
        // If no explicit roots, take first node
        entryPoint = this.nodes[0]?.name;
      } else if (roots.length === 1) {
        entryPoint = roots[0];
      } else {
        // Multiple roots - take first one
        entryPoint = roots[0];
      }
    }

    if (!entryPoint) {
      throw new Error('Workflow has no nodes');
    }

    // Validate
    this.validate(nodesMap, edges, entryPoint);

    return {
      name: this.name,
      initialState: this.state,
      nodes: nodesMap,
      edges,
      entryPoint,
    };
  }

  private validate(
    nodes: Map<string, WorkflowNode<S>>,
    edges: Edge[],
    entryPoint: string
  ): void {
    // Check entry point exists
    if (!nodes.has(entryPoint)) {
      throw new Error(`Entry point '${entryPoint}' not found in nodes`);
    }

    // Check all edge references exist
    for (const edge of edges) {
      if (!nodes.has(edge.from)) {
        throw new Error(`Edge references unknown node '${edge.from}'`);
      }

      if (edge.type === 'sequential') {
        if (!nodes.has(edge.to)) {
          throw new Error(`Edge references unknown node '${edge.to}'`);
        }
      } else if (edge.type === 'parallel') {
        for (const to of edge.to) {
          if (!nodes.has(to)) {
            throw new Error(`Edge references unknown node '${to}'`);
          }
        }
      } else if (edge.type === 'conditional') {
        for (const target of edge.targets) {
          if (!nodes.has(target)) {
            throw new Error(`Conditional references unknown node '${target}'`);
          }
        }
      } else if (edge.type === 'loop') {
        if (!nodes.has(edge.back)) {
          throw new Error(`Loop references unknown back node '${edge.back}'`);
        }
        if (!nodes.has(edge.exit)) {
          throw new Error(`Loop references unknown exit node '${edge.exit}'`);
        }
      }
    }
  }
}
