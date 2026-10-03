/**
 * Adapters that turn timer, human, map-reduce and subworkflow configurations into nodes
 * that can be added to a WorkflowBuilder.
 */

import type {
  ApprovalNotifier,
  ApprovalStore,
  CheckpointStore,
  HumanNodeConfig,
  NodeContext,
  NodeResult,
  TimerStore,
  WorkflowNode,
  WorkflowState,
} from '@cogitator-ai/types';
import type { ExtendedNodeContext } from './base';
import {
  executeTimerNode,
  type AnyTimerNodeConfig,
  type TimerNodeResult,
} from '../timers/timer-node';
import { executeHumanNode, type HumanNodeResult } from '../human/human-node';
import {
  executeMap,
  executeMapReduce,
  type MapItemResult,
  type MapNodeConfig,
  type MapReduceNodeConfig,
  type MapReduceResult,
} from '../patterns/map-reduce';
import {
  executeSubworkflow,
  type SubworkflowConfig,
  type SubworkflowContext,
  type SubworkflowResult,
} from '../subworkflows/subworkflow-node';
import {
  executeParallelSubworkflows,
  type ParallelSubworkflowsConfig,
  type ParallelSubworkflowsResult,
} from '../subworkflows/parallel-subworkflows';

function extended<S>(ctx: NodeContext<S>): Partial<ExtendedNodeContext<S>> {
  return ctx as Partial<ExtendedNodeContext<S>>;
}

export interface TimerWorkflowNodeOptions<S> {
  /** Persist timers so they survive restarts (used with `persist: true` configs) */
  timerStore?: TimerStore;
  stateMapper?: (result: TimerNodeResult, state: S) => Partial<S>;
}

/**
 * Wait according to a timer config (`delayNode`, `dynamicDelayNode`, `cronWaitNode`,
 * `untilNode`). The wait is cancelled when the workflow run is aborted.
 */
export function timerWorkflowNode<S extends WorkflowState>(
  config: AnyTimerNodeConfig<S>,
  options: TimerWorkflowNodeOptions<S> = {}
): WorkflowNode<S> {
  return {
    name: config.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const result = await executeTimerNode(config, ctx.state, {
        workflowId: ctx.workflowId,
        runId: ctx.workflowId,
        nodeId: ctx.nodeId,
        timerStore: options.timerStore ?? extended(ctx).timerStore,
        signal: extended(ctx).signal,
        onTimerScheduled: extended(ctx).onTimerScheduled,
      });
      return { output: result, state: options.stateMapper?.(result, ctx.state) };
    },
  };
}

export interface HumanWorkflowNodeOptions<S extends WorkflowState> {
  /** Defaults to the run's `approvalStore` execute option */
  approvalStore?: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
  /** Copy the decision into the workflow state, e.g. for a following conditional */
  stateMapper?: (result: HumanNodeResult<S>, state: S) => Partial<S>;
}

/**
 * Pause the workflow until a human responds to the approval request built from `config`
 * (`approvalNode`, `choiceNode`, `inputNode`, `ratingNode`, `chainNode`, `managementChain`).
 */
export function humanWorkflowNode<S extends WorkflowState>(
  config: HumanNodeConfig<S>,
  options: HumanWorkflowNodeOptions<S> = {}
): WorkflowNode<S> {
  return {
    name: config.name ?? config.approval.title,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const approvalStore = options.approvalStore ?? extended(ctx).approvalStore;
      if (!approvalStore) {
        throw new Error(
          `Human node '${ctx.nodeId}' needs an approvalStore (node option or execute option)`
        );
      }
      const result = await executeHumanNode(ctx.state, config, {
        workflowId: ctx.workflowId,
        runId: ctx.workflowId,
        nodeId: ctx.nodeId,
        approvalStore,
        approvalNotifier: options.approvalNotifier ?? extended(ctx).approvalNotifier,
        onApprovalRequired: extended(ctx).onApprovalRequired,
      });
      return {
        output: {
          approved: result.approved,
          decision: result.decision,
          timedOut: result.timedOut ?? false,
          escalated: result.escalated ?? false,
          withdrawn: result.withdrawn ?? false,
        },
        state: options.stateMapper?.(result, ctx.state),
      };
    },
  };
}

/**
 * Process every item of a collection in parallel (`mapNode` config).
 */
export function mapWorkflowNode<S extends WorkflowState, T>(
  config: MapNodeConfig<S, T>,
  options: { stateMapper?: (results: MapItemResult<T>[], state: S) => Partial<S> } = {}
): WorkflowNode<S> {
  return {
    name: config.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const results = await executeMap(ctx.state, config);
      return { output: results, state: options.stateMapper?.(results, ctx.state) };
    },
  };
}

/**
 * Map items in parallel and reduce the results (`mapReduceNode` config).
 */
export function mapReduceWorkflowNode<S extends WorkflowState, T, R>(
  config: MapReduceNodeConfig<S, T, R>,
  options: { stateMapper?: (result: MapReduceResult<T, R>, state: S) => Partial<S> } = {}
): WorkflowNode<S> {
  return {
    name: config.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const result = await executeMapReduce(ctx.state, config);
      return { output: result.reduced, state: options.stateMapper?.(result, ctx.state) };
    },
  };
}

export interface SubworkflowNodeOptions {
  /** Checkpoint store shared with child workflows (see `shareCheckpoints`) */
  checkpointStore?: CheckpointStore;
}

function subworkflowContext<S>(
  ctx: NodeContext<S>,
  options: SubworkflowNodeOptions
): SubworkflowContext {
  const ext = extended(ctx);
  if (!ext.cogitator) {
    throw new Error(`Subworkflow node '${ctx.nodeId}' requires a Cogitator in the node context`);
  }
  return {
    cogitator: ext.cogitator,
    parentWorkflowId: ctx.workflowId,
    parentRunId: ctx.workflowId,
    parentNodeId: ctx.nodeId,
    depth: (ext.depth ?? 0) + 1,
    checkpointStore: options.checkpointStore,
    signal: ext.signal,
  };
}

function caughtError(error: Error | undefined): { name: string; message: string } {
  return error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: 'Subworkflow failed' };
}

/**
 * Run another workflow as a step (`subworkflowNode`, `simpleSubworkflow`,
 * `nestedSubworkflow`, `conditionalSubworkflow` configs). The parent state returned by the
 * config's `outputMapper` replaces the current state. With `onError: 'catch'` a failed child
 * leaves the state as it was and the node outputs `{ error: { name, message } }`.
 */
export function subworkflowWorkflowNode<PS extends WorkflowState, CS extends WorkflowState>(
  config: SubworkflowConfig<PS, CS>,
  options: SubworkflowNodeOptions = {}
): WorkflowNode<PS> {
  return {
    name: config.name,
    fn: async (ctx): Promise<NodeResult<PS>> => {
      const result: SubworkflowResult<PS, CS> = await executeSubworkflow(
        ctx.state,
        config,
        subworkflowContext(ctx, options)
      );
      if (!result.success) {
        return {
          state: result.parentState,
          output: { error: caughtError(result.error) },
        };
      }
      return {
        state: result.parentState,
        output: result.skipped ? { skipped: true } : result.childResult?.state,
      };
    },
  };
}

/**
 * Run several workflows concurrently and aggregate their results
 * (`parallelSubworkflows`, `fanOutFanIn`, `scatterGather` configs).
 */
export function parallelSubworkflowsNode<
  S extends WorkflowState,
  CS extends WorkflowState = WorkflowState,
>(
  config: ParallelSubworkflowsConfig<S, CS>,
  options: SubworkflowNodeOptions = {}
): WorkflowNode<S> {
  return {
    name: config.name,
    fn: async (ctx): Promise<NodeResult<S>> => {
      const result: ParallelSubworkflowsResult<S, CS> = await executeParallelSubworkflows(
        ctx.state,
        config,
        subworkflowContext(ctx, options)
      );
      if (!result.success && result.errors.size > 0 && !config.continueOnError) {
        throw result.errors.values().next().value ?? new Error('Parallel subworkflows failed');
      }
      return { state: result.parentState, output: result.stats };
    },
  };
}
