/**
 * SwarmNode - Run a swarm as a workflow node
 */

import type {
  WorkflowNode,
  WorkflowState,
  NodeContext,
  NodeResult,
  SwarmConfig,
  SwarmRunOptions,
  StrategyResult,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { Swarm } from '../swarm';

/**
 * Extended context with Cogitator for swarm nodes
 */
export interface SwarmNodeContext<S = WorkflowState> extends NodeContext<S> {
  cogitator: Cogitator;
}

export interface SwarmNodeOptions<S = WorkflowState> {
  /**
   * Map swarm result to state updates
   */
  stateMapper?: (result: StrategyResult) => Partial<S>;

  /**
   * Map current state to swarm input
   */
  inputMapper?: (state: S, input?: unknown) => string;

  /**
   * Additional run options for the swarm
   */
  runOptions?: Partial<SwarmRunOptions>;
}

/**
 * Create a workflow node that runs a swarm
 */
export function swarmNode<S extends WorkflowState = WorkflowState>(
  swarmOrConfig: Swarm | SwarmConfig,
  options?: SwarmNodeOptions<S>
): WorkflowNode<S> {
  const name = swarmOrConfig instanceof Swarm
    ? swarmOrConfig.name
    : swarmOrConfig.name;

  return {
    name: `swarm:${name}`,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const extCtx = ctx as SwarmNodeContext<S>;

      const swarm = swarmOrConfig instanceof Swarm
        ? swarmOrConfig
        : new Swarm(extCtx.cogitator, swarmOrConfig);

      let input: string;
      if (options?.inputMapper) {
        input = options.inputMapper(ctx.state, ctx.input);
      } else if (typeof ctx.input === 'string') {
        input = ctx.input;
      } else if (ctx.input !== undefined) {
        input = JSON.stringify(ctx.input);
      } else {
        input = JSON.stringify(ctx.state);
      }

      const result = await swarm.run({
        input,
        context: {
          workflowContext: {
            nodeId: ctx.nodeId,
            step: ctx.step,
            workflowState: ctx.state,
          },
        },
        ...options?.runOptions,
      });

      const stateUpdate = options?.stateMapper?.(result);

      return {
        state: stateUpdate,
        output: result.output,
      };
    },
  };
}

/**
 * Create a conditional swarm node that only runs if condition is met
 */
export function conditionalSwarmNode<S extends WorkflowState = WorkflowState>(
  swarmOrConfig: Swarm | SwarmConfig,
  condition: (state: S, ctx: NodeContext<S>) => boolean,
  options?: SwarmNodeOptions<S>
): WorkflowNode<S> {
  const baseNode = swarmNode(swarmOrConfig, options);

  return {
    name: baseNode.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      if (!condition(ctx.state, ctx)) {
        return {
          output: null,
        };
      }
      return baseNode.fn(ctx);
    },
  };
}

/**
 * Create a node that runs multiple swarms in parallel and merges results
 */
export function parallelSwarmsNode<S extends WorkflowState = WorkflowState>(
  swarms: {
    swarm: Swarm | SwarmConfig;
    key: string;
    options?: SwarmNodeOptions<S>;
  }[],
  mergeResults?: (results: Record<string, StrategyResult>) => Partial<S>
): WorkflowNode<S> {
  return {
    name: `parallel-swarms:${swarms.map(s => {
      const swarm = s.swarm instanceof Swarm ? s.swarm : s.swarm;
      return 'name' in swarm ? swarm.name : 'unnamed';
    }).join(',')}`,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const extCtx = ctx as SwarmNodeContext<S>;
      const results: Record<string, StrategyResult> = {};

      await Promise.all(
        swarms.map(async ({ swarm: swarmOrConfig, key, options }) => {
          const swarm = swarmOrConfig instanceof Swarm
            ? swarmOrConfig
            : new Swarm(extCtx.cogitator, swarmOrConfig);

          let input: string;
          if (options?.inputMapper) {
            input = options.inputMapper(ctx.state, ctx.input);
          } else if (typeof ctx.input === 'string') {
            input = ctx.input;
          } else if (ctx.input !== undefined) {
            input = JSON.stringify(ctx.input);
          } else {
            input = JSON.stringify(ctx.state);
          }

          const result = await swarm.run({
            input,
            ...options?.runOptions,
          });

          results[key] = result;
        })
      );

      const stateUpdate = mergeResults?.(results);

      return {
        state: stateUpdate,
        output: results,
      };
    },
  };
}
