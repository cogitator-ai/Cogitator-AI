import { NextResponse } from 'next/server';
import { getWorkflow, getAgent, createWorkflowRun, updateWorkflowRun } from '@/lib/cogitator/db';
import { getCogitator, getAvailableTools } from '@/lib/cogitator';
import {
  WorkflowExecutor,
  WorkflowBuilder,
  agentNode,
  toolNode,
  functionNode,
  InMemoryCheckpointStore,
} from '@cogitator-ai/workflows';
import { Agent, type Tool } from '@cogitator-ai/core';
import type { WorkflowState, NodeResult } from '@cogitator-ai/types';
import { withAuth } from '@/lib/auth/middleware';

interface WorkflowNodeDefinition {
  id: string;
  type: 'agent' | 'tool' | 'function' | 'delay' | 'start' | 'end';
  label?: string;
  agentId?: string;
  toolName?: string;
  code?: string;
  delay?: number;
  config?: Record<string, unknown>;
}

interface WorkflowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  type?: 'sequential' | 'conditional';
  condition?: string;
}

interface WorkflowDefinition {
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

export const POST = withAuth(async (request, context) => {
  try {
    const { id } = await context!.params!;
    const body = await request.json();
    const { input, initialState } = body;

    console.log('[workflow-run] Starting workflow execution for:', id);

    const workflowData = await getWorkflow(id);
    if (!workflowData) {
      return NextResponse.json({ error: 'Workflow not found' }, { status: 404 });
    }

    const cogitator = await getCogitator();
    const availableTools = getAvailableTools();
    const definition = workflowData.definition as WorkflowDefinition;

    if (!definition?.nodes || !definition?.edges) {
      return NextResponse.json(
        { error: 'Invalid workflow definition - missing nodes or edges' },
        { status: 400 }
      );
    }

    const run = await createWorkflowRun({
      workflowId: id,
      input: typeof input === 'string' ? input : JSON.stringify(input || {}),
    });

    console.log('[workflow-run] Created run:', run.id);

    const builder = new WorkflowBuilder<WorkflowState>(workflowData.name)
      .initialState({
        input: input || '',
        results: {},
        ...(initialState || {}),
        ...(workflowData.initialState as WorkflowState || {}),
      });

    const nodeDependencies = new Map<string, string[]>();
    for (const edge of definition.edges) {
      const deps = nodeDependencies.get(edge.target) || [];
      if (edge.source !== 'start' && !deps.includes(edge.source)) {
        deps.push(edge.source);
      }
      nodeDependencies.set(edge.target, deps);
    }

    const entryNode = definition.edges.find(e => e.source === 'start')?.target;
    if (!entryNode) {
      await updateWorkflowRun(run.id, {
        status: 'failed',
        error: 'No entry point found - workflow must have a start node',
      });
      return NextResponse.json(
        { error: 'No entry point found in workflow' },
        { status: 400 }
      );
    }

    for (const nodeDef of definition.nodes) {
      if (nodeDef.type === 'start' || nodeDef.type === 'end') continue;

      const deps = nodeDependencies.get(nodeDef.id) || [];

      try {
        switch (nodeDef.type) {
          case 'agent': {
            if (!nodeDef.agentId) {
              throw new Error(`Agent node ${nodeDef.id} missing agentId`);
            }
            const agentData = await getAgent(nodeDef.agentId);
            if (!agentData) {
              throw new Error(`Agent ${nodeDef.agentId} not found`);
            }

            const agent = new Agent({
              id: agentData.id,
              name: agentData.name,
              model: agentData.model,
              instructions: agentData.instructions || 'You are a helpful assistant.',
              tools: [],
            });

            const agentWorkflowNode = agentNode(agent, {
              inputMapper: (state) => {
                return typeof state.input === 'string'
                  ? state.input
                  : JSON.stringify(state);
              },
              stateMapper: (result) => ({
                results: { [nodeDef.id]: result.output },
              }),
            });

            builder.addNode(nodeDef.id, agentWorkflowNode.fn, {
              after: deps.length > 0 ? deps : undefined,
            });
            break;
          }

          case 'tool': {
            if (!nodeDef.toolName) {
              throw new Error(`Tool node ${nodeDef.id} missing toolName`);
            }
            const tool = availableTools.find(t => t.name === nodeDef.toolName);
            if (!tool) {
              throw new Error(`Tool ${nodeDef.toolName} not found`);
            }

            const toolWorkflowNode = toolNode(tool as Tool<unknown, unknown>, {
              argsMapper: (state, nodeInput) => {
                if (nodeDef.config?.args) {
                  return nodeDef.config.args as unknown;
                }
                return nodeInput || state.input || {};
              },
              stateMapper: (result) => ({
                results: { [nodeDef.id]: result },
              }),
            });

            builder.addNode(nodeDef.id, toolWorkflowNode.fn, {
              after: deps.length > 0 ? deps : undefined,
            });
            break;
          }

          case 'function': {
            const code = nodeDef.code || nodeDef.config?.code as string || '';
            const fnNode = functionNode(nodeDef.id, async (ctx): Promise<NodeResult<WorkflowState>> => {
              try {
                const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
                const fn = new AsyncFunction('state', 'input', code);
                const result = await fn(ctx.state, ctx.input);
                return {
                  state: { results: { [nodeDef.id]: result } },
                  output: result,
                };
              } catch (error) {
                return {
                  output: { error: String(error) },
                };
              }
            });

            builder.addNode(nodeDef.id, fnNode.fn, {
              after: deps.length > 0 ? deps : undefined,
            });
            break;
          }

          case 'delay': {
            const delayMs = nodeDef.delay || nodeDef.config?.delay as number || 1000;

            builder.addNode(nodeDef.id, async (ctx) => {
              await new Promise(resolve => setTimeout(resolve, delayMs));
              return { state: ctx.state };
            }, {
              after: deps.length > 0 ? deps : undefined,
            });
            break;
          }
        }
      } catch (nodeError) {
        console.error(`[workflow-run] Failed to create node ${nodeDef.id}:`, nodeError);
        await updateWorkflowRun(run.id, {
          status: 'failed',
          error: `Failed to create node ${nodeDef.id}: ${String(nodeError)}`,
        });
        return NextResponse.json(
          { error: `Failed to create node ${nodeDef.id}: ${String(nodeError)}` },
          { status: 400 }
        );
      }
    }

    builder.entryPoint(entryNode);

    const workflow = builder.build();
    console.log('[workflow-run] Workflow built with', workflow.nodes.size, 'nodes');

    const checkpointStore = new InMemoryCheckpointStore();
    const executor = new WorkflowExecutor(cogitator, checkpointStore);

    const startTime = Date.now();
    const eventLog: string[] = [];

    try {
      const result = await executor.execute(workflow, { input }, {
        maxConcurrency: 2,
        maxIterations: 50,
        checkpoint: true,
        onNodeStart: (nodeName) => {
          const event = `[${new Date().toISOString()}] node:start ${nodeName}`;
          eventLog.push(event);
          console.log('[workflow-run]', event);
        },
        onNodeComplete: (nodeName, output, duration) => {
          const event = `[${new Date().toISOString()}] node:complete ${nodeName} (${duration}ms)`;
          eventLog.push(event);
          console.log('[workflow-run]', event);
        },
        onNodeError: (nodeName, error) => {
          const event = `[${new Date().toISOString()}] node:error ${nodeName}: ${error.message}`;
          eventLog.push(event);
          console.error('[workflow-run]', event);
        },
      });

      const duration = Date.now() - startTime;

      const nodeResultsObj: Record<string, unknown> = {};
      for (const [key, value] of result.nodeResults.entries()) {
        nodeResultsObj[key] = value;
      }

      await updateWorkflowRun(run.id, {
        status: result.error ? 'failed' : 'completed',
        output: result.error ? undefined : JSON.stringify(result.state),
        error: result.error?.message,
        duration,
      });

      console.log('[workflow-run] Completed in', duration, 'ms');

      return NextResponse.json({
        runId: run.id,
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        status: result.error ? 'failed' : 'completed',
        state: result.state,
        nodeResults: nodeResultsObj,
        duration,
        checkpointId: result.checkpointId,
        error: result.error?.message,
        eventLog,
      });

    } catch (execError) {
      const duration = Date.now() - startTime;
      const errorMessage = execError instanceof Error ? execError.message : String(execError);

      await updateWorkflowRun(run.id, {
        status: 'failed',
        error: errorMessage,
        duration,
      });

      console.error('[workflow-run] Execution failed:', errorMessage);

      return NextResponse.json({
        runId: run.id,
        status: 'failed',
        error: errorMessage,
        duration,
        eventLog,
      }, { status: 500 });
    }

  } catch (error) {
    console.error('[workflow-run] Fatal error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to run workflow' },
      { status: 500 }
    );
  }
});
