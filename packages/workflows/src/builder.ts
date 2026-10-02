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
  AddParallelOptions,
  NodeConfig,
} from '@cogitator-ai/types';

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

interface InternalParallel {
  name: string;
  targets: string[];
  after: string[];
}

export class WorkflowBuilder<S extends WorkflowState = WorkflowState> {
  private name: string;
  private state: S;
  private nodes: InternalNode<S>[] = [];
  private conditionals: InternalConditional<S>[] = [];
  private loops: InternalLoop<S>[] = [];
  private parallels: InternalParallel[] = [];
  private entryPointName: string | null = null;
  private usedNames = new Set<string>();

  constructor(name: string) {
    this.name = name;
    this.state = {} as S;
  }

  private registerName(name: string): void {
    if (this.usedNames.has(name)) {
      throw new Error(`Duplicate node name '${name}'`);
    }
    this.usedNames.add(name);
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
   * Add a node to the workflow. Accepts a node function or a node created by a factory
   * (`agentNode`, `toolNode`, `functionNode`, `customNode`, ...).
   */
  addNode(name: string, node: NodeFn<S> | WorkflowNode<S>, options?: AddNodeOptions): this {
    this.registerName(name);
    const fn = typeof node === 'function' ? node : node.fn;
    const nodeConfig = typeof node === 'function' ? undefined : node.config;
    const config =
      nodeConfig || options?.config ? { ...nodeConfig, ...options?.config } : undefined;

    this.nodes.push({
      name,
      fn,
      config,
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
    this.registerName(name);
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
    this.registerName(name);
    this.loops.push({
      name,
      condition: options.condition as (state: S) => boolean,
      back: options.back,
      exit: options.exit,
      after: options.after ?? [],
    });
    return this;
  }

  addParallel(name: string, targets: string[], options?: AddParallelOptions): this {
    this.registerName(name);
    this.parallels.push({
      name,
      targets,
      after: options?.after ?? [],
    });
    return this;
  }

  /**
   * Build and validate the workflow
   */
  build(): Workflow<S> {
    const nodesMap = new Map<string, WorkflowNode<S>>();

    for (const node of this.nodes) {
      nodesMap.set(node.name, {
        name: node.name,
        fn: node.fn,
        config: node.config,
      });
    }

    for (const cond of this.conditionals) {
      nodesMap.set(cond.name, {
        name: cond.name,
        fn: async (ctx) => ({ output: ctx.state }),
        config: undefined,
      });
    }

    for (const loop of this.loops) {
      nodesMap.set(loop.name, {
        name: loop.name,
        fn: async (ctx) => ({ output: ctx.state }),
        config: undefined,
      });
    }

    for (const parallel of this.parallels) {
      nodesMap.set(parallel.name, {
        name: parallel.name,
        fn: async (ctx) => ({ output: ctx.state }),
        config: undefined,
      });
    }

    const conditionalNames = new Set(this.conditionals.map((c) => c.name));
    const loopsByName = new Map(this.loops.map((l) => [l.name, l]));

    const entries: { name: string; after: string[] }[] = [
      ...this.nodes,
      ...this.conditionals,
      ...this.loops,
      ...this.parallels,
    ];

    const edges: Edge[] = [];
    const conditionalTargets = new Map<string, string[]>();
    const parallelTargets = new Map(this.parallels.map((p) => [p.name, [...p.targets]]));

    for (const entry of entries) {
      for (const dep of entry.after) {
        if (conditionalNames.has(dep)) {
          const targets = conditionalTargets.get(dep) ?? [];
          targets.push(entry.name);
          conditionalTargets.set(dep, targets);
          continue;
        }

        const loop = loopsByName.get(dep);
        if (loop) {
          if (entry.name !== loop.back && entry.name !== loop.exit) {
            throw new Error(
              `'${entry.name}' runs after loop '${dep}' but is neither its back ('${loop.back}') nor exit ('${loop.exit}') node`
            );
          }
          continue;
        }

        const parallelTargetList = parallelTargets.get(dep);
        if (parallelTargetList) {
          if (!parallelTargetList.includes(entry.name)) {
            parallelTargetList.push(entry.name);
          }
          continue;
        }

        edges.push({ type: 'sequential', from: dep, to: entry.name });
      }
    }

    for (const cond of this.conditionals) {
      const targets = conditionalTargets.get(cond.name) ?? [];
      if (targets.length > 0) {
        edges.push({
          type: 'conditional',
          from: cond.name,
          condition: cond.condition as (state: unknown) => string | string[],
          targets,
        });
      }
    }

    for (const loop of this.loops) {
      edges.push({
        type: 'loop',
        from: loop.name,
        condition: loop.condition as (state: unknown) => boolean,
        back: loop.back,
        exit: loop.exit,
      });
    }

    for (const parallel of this.parallels) {
      edges.push({
        type: 'parallel',
        from: parallel.name,
        to: parallelTargets.get(parallel.name) ?? [],
      });
    }

    this.validateEdges(nodesMap, edges);

    let entryPoint = this.entryPointName;

    if (!entryPoint) {
      const routedTargets = new Set<string>();
      for (const targets of parallelTargets.values()) {
        for (const target of targets) routedTargets.add(target);
      }
      for (const loop of this.loops) {
        routedTargets.add(loop.exit);
      }

      const roots = entries
        .filter((e) => e.after.length === 0 && !routedTargets.has(e.name))
        .map((e) => e.name);

      if (entries.length === 0) {
        throw new Error('Workflow has no nodes');
      }

      if (roots.length === 0) {
        throw new Error(
          'Workflow has no root node (every node depends on another). ' +
            'Use .entryPoint() to specify where execution starts.'
        );
      }

      if (roots.length > 1) {
        throw new Error(
          `Workflow has multiple root nodes: ${roots.join(', ')}. ` +
            'Use .entryPoint() to specify which one should be the entry point.'
        );
      }

      entryPoint = roots[0];
    }

    if (!nodesMap.has(entryPoint)) {
      throw new Error(`Entry point '${entryPoint}' not found in nodes`);
    }

    return {
      name: this.name,
      initialState: this.state,
      nodes: nodesMap,
      edges,
      entryPoint,
    };
  }

  private validateEdges(nodes: Map<string, WorkflowNode<S>>, edges: Edge[]): void {
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
