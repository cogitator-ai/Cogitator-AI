/**
 * WorkflowScheduler - Manages DAG execution order and parallel scheduling
 */

import type {
  Workflow,
  WorkflowState,
} from '@cogitator-ai/types';

interface DependencyGraph {
  dependencies: Map<string, Set<string>>;
  dependents: Map<string, Set<string>>;
}

export class WorkflowScheduler {
  /**
   * Build dependency graph from workflow edges
   */
  buildDependencyGraph<S extends WorkflowState>(
    workflow: Workflow<S>
  ): DependencyGraph {
    const dependencies = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();

    for (const nodeName of workflow.nodes.keys()) {
      dependencies.set(nodeName, new Set());
      dependents.set(nodeName, new Set());
    }

    for (const edge of workflow.edges) {
      if (edge.type === 'sequential') {
        dependencies.get(edge.to)?.add(edge.from);
        dependents.get(edge.from)?.add(edge.to);
      } else if (edge.type === 'parallel') {
        for (const to of edge.to) {
          dependencies.get(to)?.add(edge.from);
          dependents.get(edge.from)?.add(to);
        }
      }
    }

    return { dependencies, dependents };
  }

  /**
   * Get nodes ready to execute (all dependencies completed)
   */
  getReadyNodes(
    graph: DependencyGraph,
    completed: Set<string>,
    pending: Set<string>
  ): string[] {
    const ready: string[] = [];

    for (const nodeName of pending) {
      const deps = graph.dependencies.get(nodeName);
      if (!deps) continue;

      let allDepsCompleted = true;
      for (const dep of deps) {
        if (!completed.has(dep)) {
          allDepsCompleted = false;
          break;
        }
      }

      if (allDepsCompleted) {
        ready.push(nodeName);
      }
    }

    return ready;
  }

  /**
   * Get topological order of nodes (grouped by execution level)
   * Returns array of arrays, where each inner array can be executed in parallel
   */
  getExecutionLevels<S extends WorkflowState>(
    workflow: Workflow<S>
  ): string[][] {
    const graph = this.buildDependencyGraph(workflow);
    const levels: string[][] = [];
    const completed = new Set<string>();
    const pending = new Set(workflow.nodes.keys());

    while (pending.size > 0) {
      const ready = this.getReadyNodes(graph, completed, pending);

      if (ready.length === 0 && pending.size > 0) {
        throw new Error(
          `Workflow has cycles or unreachable nodes: ${Array.from(pending).join(', ')}`
        );
      }

      levels.push(ready);

      for (const node of ready) {
        completed.add(node);
        pending.delete(node);
      }
    }

    return levels;
  }

  /**
   * Find the next node(s) to execute based on current state and edge conditions
   */
  getNextNodes<S extends WorkflowState>(
    workflow: Workflow<S>,
    currentNode: string,
    state: S
  ): string[] {
    const nextNodes: string[] = [];

    for (const edge of workflow.edges) {
      if (edge.from !== currentNode) continue;

      if (edge.type === 'sequential') {
        nextNodes.push(edge.to);
      } else if (edge.type === 'parallel') {
        nextNodes.push(...edge.to);
      } else if (edge.type === 'conditional') {
        const result = edge.condition(state);
        const targets = Array.isArray(result) ? result : [result];

        for (const target of targets) {
          if (edge.targets.includes(target)) {
            nextNodes.push(target);
          }
        }
      } else if (edge.type === 'loop') {
        const shouldLoop = edge.condition(state);
        if (shouldLoop) {
          nextNodes.push(edge.back);
        } else {
          nextNodes.push(edge.exit);
        }
      }
    }

    return [...new Set(nextNodes)];
  }

  /**
   * Run multiple async tasks with concurrency limit
   */
  async runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrency: number
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      const promise = task().then((result) => {
        results.push(result);
      });

      executing.push(promise);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
        const newExecuting: Promise<void>[] = [];
        for (const p of executing) {
          const pending = await Promise.race([
            p.then(() => false),
            Promise.resolve(true),
          ]);
          if (pending) {
            newExecuting.push(p);
          }
        }
        executing.length = 0;
        executing.push(...newExecuting);
      }
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Simpler parallel execution with Promise.all and concurrency via chunking
   */
  async runParallel<T>(
    tasks: (() => Promise<T>)[],
    maxConcurrency: number
  ): Promise<T[]> {
    const results: T[] = [];

    for (let i = 0; i < tasks.length; i += maxConcurrency) {
      const chunk = tasks.slice(i, i + maxConcurrency);
      const chunkResults = await Promise.all(chunk.map((t) => t()));
      results.push(...chunkResults);
    }

    return results;
  }
}
