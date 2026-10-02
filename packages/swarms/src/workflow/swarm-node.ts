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

function resolveSwarmInput<S extends WorkflowState>(
  ctx: NodeContext<S>,
  options?: SwarmNodeOptions<S>
): string {
  if (options?.inputMapper) return options.inputMapper(ctx.state, ctx.input);
  if (typeof ctx.input === 'string') return ctx.input;
  if (ctx.input !== undefined) return JSON.stringify(ctx.input);
  return JSON.stringify(ctx.state);
}

function requireCogitator<S extends WorkflowState>(ctx: NodeContext<S>): Cogitator {
  if (!('cogitator' in ctx)) {
    throw new Error('SwarmNode requires cogitator in context');
  }
  return (ctx as SwarmNodeContext<S>).cogitator;
}

async function runSwarmForNode<S extends WorkflowState>(
  swarmOrConfig: Swarm | SwarmConfig,
  ctx: NodeContext<S>,
  options?: SwarmNodeOptions<S>
): Promise<StrategyResult> {
  const cogitator = requireCogitator(ctx);
  const isOwned = !(swarmOrConfig instanceof Swarm);
  const swarm =
    swarmOrConfig instanceof Swarm ? swarmOrConfig : new Swarm(cogitator, swarmOrConfig);

  try {
    return await swarm.run({
      input: resolveSwarmInput(ctx, options),
      ...options?.runOptions,
      context: {
        ...options?.runOptions?.context,
        workflowContext: {
          nodeId: ctx.nodeId,
          step: ctx.step,
          workflowState: ctx.state,
        },
      },
    });
  } finally {
    if (isOwned) {
      await swarm.close();
    }
  }
}

/**
 * Create a workflow node that runs a swarm
 */
export function swarmNode<S extends WorkflowState = WorkflowState>(
  swarmOrConfig: Swarm | SwarmConfig,
  options?: SwarmNodeOptions<S>
): WorkflowNode<S> {
  return {
    name: `swarm:${swarmOrConfig.name}`,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const result = await runSwarmForNode(swarmOrConfig, ctx, options);
      return {
        state: options?.stateMapper?.(result),
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
    name: `parallel-swarms:${swarms.map((s) => s.swarm.name).join(',')}`,
    fn: async (ctx): Promise<NodeResult<S>> => {
      requireCogitator(ctx);

      const settled = await Promise.allSettled(
        swarms.map(({ swarm, options }) => runSwarmForNode(swarm, ctx, options))
      );

      const results: Record<string, StrategyResult> = {};
      const errors: { key: string; error: unknown }[] = [];

      settled.forEach((outcome, index) => {
        const { key } = swarms[index];
        if (outcome.status === 'fulfilled') {
          results[key] = outcome.value;
        } else {
          errors.push({ key, error: outcome.reason });
        }
      });

      if (errors.length > 0 && Object.keys(results).length === 0) {
        throw new AggregateError(
          errors.map((e) => e.error),
          `All parallel swarms failed: ${errors.map((e) => e.key).join(', ')}`
        );
      }

      return {
        state: mergeResults?.(results),
        output: results,
      };
    },
  };
}
