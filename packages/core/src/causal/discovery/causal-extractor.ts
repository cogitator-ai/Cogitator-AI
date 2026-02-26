import type {
  CausalGraph,
  CausalNode,
  CausalEdge,
  CausalRelationType,
  VariableType,
  ExecutionTrace,
  ToolCall,
  LLMBackend,
} from '@cogitator-ai/types';
import {
  buildCausalExtractionPrompt,
  parseCausalExtractionResponse,
  ExtractedRelationship,
} from './prompts';
import { nanoid } from 'nanoid';

export interface CausalExtractorOptions {
  llmBackend: LLMBackend;
  model?: string;
  minConfidence?: number;
  minStrength?: number;
  batchSize?: number;
}

export class CausalExtractor {
  private llm: LLMBackend;
  private model: string;
  private minConfidence: number;
  private minStrength: number;
  private batchSize: number;

  constructor(options: CausalExtractorOptions) {
    this.llm = options.llmBackend;
    this.model = options.model ?? 'gpt-4';
    this.minConfidence = options.minConfidence ?? 0.3;
    this.minStrength = options.minStrength ?? 0.1;
    this.batchSize = options.batchSize ?? 5;
  }

  async extractFromText(
    text: string,
    graph: CausalGraph,
    context?: { taskDescription?: string; recentActions?: string[] }
  ): Promise<{ nodes: CausalNode[]; edges: CausalEdge[] }> {
    const existingNodes = graph.getNodes();
    const prompt = buildCausalExtractionPrompt(text, existingNodes, context);

    const response = await this.llm.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const content = response.content;
    const parsed = parseCausalExtractionResponse(content);

    if (!parsed) {
      return { nodes: [], edges: [] };
    }

    return this.processExtractionResult(parsed.relationships, graph);
  }

  async extractFromToolResult(
    toolCall: ToolCall,
    result: unknown,
    context: { taskDescription?: string; previousActions?: string[] },
    graph: CausalGraph
  ): Promise<{ nodes: CausalNode[]; edges: CausalEdge[] }> {
    const text = `Tool execution:
Tool: ${toolCall.name}
Input: ${JSON.stringify(toolCall.arguments)}
Result: ${JSON.stringify(result)}

The agent called this tool as part of task: ${context.taskDescription || 'Unknown task'}
Previous actions: ${context.previousActions?.join(', ') || 'None'}`;

    return this.extractFromText(text, graph, context);
  }

  async extractFromTrace(
    trace: ExecutionTrace,
    graph: CausalGraph
  ): Promise<{ nodes: CausalNode[]; edges: CausalEdge[] }> {
    const allNodes: CausalNode[] = [];
    const allEdges: CausalEdge[] = [];

    const batches: ExecutionTrace['steps'][] = [];
    for (let i = 0; i < trace.steps.length; i += this.batchSize) {
      batches.push(trace.steps.slice(i, i + this.batchSize));
    }

    for (const batch of batches) {
      const batchText = batch
        .map((step, i) => {
          const stepNum = i + 1;
          const action = step.toolCall
            ? `${step.toolCall.name}(${JSON.stringify(step.toolCall.arguments)})`
            : step.type;
          const result = step.toolResult
            ? String(step.toolResult.result).substring(0, 500)
            : step.response?.substring(0, 500) || 'No result';
          const success = !step.toolResult?.error;
          return `Step ${stepNum}:
Action: ${action}
${step.toolCall ? `Tool: ${step.toolCall.name}` : ''}
Result: ${result}
Success: ${success}`;
        })
        .join('\n\n');

      const context = {
        taskDescription: trace.context?.task as string,
        recentActions: batch.map((s) => s.toolCall?.name || s.type),
      };

      const result = await this.extractFromText(batchText, graph, context);
      allNodes.push(...result.nodes);
      allEdges.push(...result.edges);
    }

    return { nodes: allNodes, edges: allEdges };
  }

  async extractFromReflection(
    reflection: { analysis: string; insights: string[]; recommendations: string[] },
    graph: CausalGraph
  ): Promise<{ nodes: CausalNode[]; edges: CausalEdge[] }> {
    const text = `Reflection analysis:
${reflection.analysis}

Insights:
${reflection.insights.map((i) => `- ${i}`).join('\n')}

Recommendations:
${reflection.recommendations.map((r) => `- ${r}`).join('\n')}`;

    return this.extractFromText(text, graph);
  }

  private processExtractionResult(
    relationships: ExtractedRelationship[],
    graph: CausalGraph
  ): { nodes: CausalNode[]; edges: CausalEdge[] } {
    const newNodes: CausalNode[] = [];
    const newEdges: CausalEdge[] = [];
    const nodeIds = new Set(graph.getNodes().map((n) => n.id));

    for (const rel of relationships) {
      if (rel.confidence < this.minConfidence || rel.strength < this.minStrength) {
        continue;
      }

      if (!nodeIds.has(rel.cause.id)) {
        const causeNode: CausalNode = {
          id: rel.cause.id,
          name: rel.cause.name,
          variableType: this.mapVariableType(rel.cause.type),
        };
        newNodes.push(causeNode);
        nodeIds.add(rel.cause.id);
      }

      if (!nodeIds.has(rel.effect.id)) {
        const effectNode: CausalNode = {
          id: rel.effect.id,
          name: rel.effect.name,
          variableType: this.mapVariableType(rel.effect.type),
        };
        newNodes.push(effectNode);
        nodeIds.add(rel.effect.id);
      }

      const existingEdge = graph.getEdgeBetween(rel.cause.id, rel.effect.id);
      if (!existingEdge) {
        const edge: CausalEdge = {
          id: `edge-extracted-${nanoid(8)}`,
          source: rel.cause.id,
          target: rel.effect.id,
          relationType: this.mapRelationType(rel.relationType),
          strength: rel.strength,
          confidence: rel.confidence,
          mechanism: rel.mechanism,
        };
        newEdges.push(edge);
      }
    }

    return { nodes: newNodes, edges: newEdges };
  }

  private mapVariableType(type: string): VariableType {
    const mapping: Record<string, VariableType> = {
      treatment: 'treatment',
      outcome: 'outcome',
      confounder: 'confounder',
      mediator: 'mediator',
      instrumental: 'instrumental',
      collider: 'collider',
      observed: 'observed',
      latent: 'latent',
    };
    return mapping[type.toLowerCase()] ?? 'observed';
  }

  private mapRelationType(type: string): CausalRelationType {
    const mapping: Record<string, CausalRelationType> = {
      causes: 'causes',
      enables: 'enables',
      prevents: 'prevents',
      mediates: 'mediates',
      confounds: 'confounds',
      moderates: 'moderates',
    };
    return mapping[type.toLowerCase()] ?? 'causes';
  }
}
