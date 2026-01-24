import type {
  Tool,
  LLMBackend,
  CapabilityGap,
  GeneratedTool,
  ToolValidationResult,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import { z, type ZodType } from 'zod';
import { ToolValidator } from './tool-validator';
import {
  TOOL_GENERATION_SYSTEM_PROMPT,
  buildToolGenerationPrompt,
  buildToolImprovementPrompt,
  parseToolGenerationResponse,
} from './prompts';

export interface ToolGeneratorOptions {
  llm: LLMBackend;
  config: ToolSelfGenerationConfig;
}

export interface GenerationResult {
  tool: GeneratedTool | null;
  validationResult: ToolValidationResult | null;
  iterations: number;
  success: boolean;
  error?: string;
}

export class ToolGenerator {
  private readonly llm: LLMBackend;
  private readonly config: ToolSelfGenerationConfig;
  private readonly validator: ToolValidator;

  constructor(options: ToolGeneratorOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.validator = new ToolValidator({
      llm: options.llm,
      config: options.config,
    });
  }

  async generate(
    gap: CapabilityGap,
    existingTools: Tool[],
    testCases?: Array<{ input: unknown; expectedOutput?: unknown }>
  ): Promise<GenerationResult> {
    let currentTool: GeneratedTool | null = null;
    let validationResult: ToolValidationResult | null = null;
    let iterations = 0;

    const maxIterations = this.config.maxIterationsPerTool || 3;

    while (iterations < maxIterations) {
      iterations++;

      try {
        if (currentTool === null) {
          currentTool = await this.generateInitial(gap, existingTools);
        } else if (validationResult) {
          currentTool = await this.improve(currentTool, validationResult, iterations);
        }

        if (!currentTool) {
          return {
            tool: null,
            validationResult: null,
            iterations,
            success: false,
            error: 'Failed to generate tool implementation',
          };
        }

        validationResult = await this.validator.validate(currentTool, testCases);

        if (validationResult.isValid) {
          currentTool.status = 'validated';
          currentTool.validationScore = validationResult.overallScore;

          return {
            tool: currentTool,
            validationResult,
            iterations,
            success: true,
          };
        }

        if (validationResult.securityIssues.length > 0 && iterations >= 2) {
          return {
            tool: currentTool,
            validationResult,
            iterations,
            success: false,
            error: `Security issues persist after ${iterations} iterations: ${validationResult.securityIssues.join(', ')}`,
          };
        }
      } catch (error) {
        return {
          tool: currentTool,
          validationResult,
          iterations,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      tool: currentTool,
      validationResult,
      iterations,
      success: false,
      error: `Failed to generate valid tool after ${maxIterations} iterations`,
    };
  }

  async generateQuick(
    description: string,
    name: string,
    _parameters: Record<string, unknown>
  ): Promise<GeneratedTool | null> {
    const gap: CapabilityGap = {
      id: `quick_${Date.now()}`,
      description,
      requiredCapability: description,
      suggestedToolName: name,
      complexity: 'simple',
      confidence: 1,
      reasoning: 'User-requested quick generation',
    };

    const result = await this.generate(gap, []);
    return result.tool;
  }

  private async generateInitial(
    gap: CapabilityGap,
    existingTools: Tool[]
  ): Promise<GeneratedTool | null> {
    const toolSummaries = existingTools.map((t) => ({
      name: t.name,
      description: t.description,
    }));

    const prompt = buildToolGenerationPrompt(gap, toolSummaries, {
      maxLines: 100,
      securityLevel: 'strict',
      allowedModules: this.config.sandboxConfig?.allowedModules,
    });

    const response = await this.callLLM(
      [
        { role: 'system', content: TOOL_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      0.4
    );

    const tool = parseToolGenerationResponse(response.content);

    if (tool) {
      tool.metadata = {
        ...tool.metadata,
        gapId: gap.id,
        complexity: gap.complexity,
      };
    }

    return tool;
  }

  private async improve(
    tool: GeneratedTool,
    validationResult: ToolValidationResult,
    iteration: number
  ): Promise<GeneratedTool | null> {
    const prompt = buildToolImprovementPrompt(tool, validationResult, iteration);

    const response = await this.callLLM(
      [
        { role: 'system', content: TOOL_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      0.3
    );

    const improved = parseToolGenerationResponse(response.content);

    if (improved) {
      improved.id = tool.id;
      improved.version = tool.version + 1;
      improved.metadata = {
        ...tool.metadata,
        ...improved.metadata,
        previousVersion: tool.version,
        improvementIteration: iteration,
      };
    }

    return improved;
  }

  createExecutableTool(generated: GeneratedTool): Tool {
    const execute = this.compileImplementation(generated.implementation);

    return {
      name: generated.name,
      description: generated.description,
      parameters: z.record(z.string(), z.unknown()) as ZodType<unknown>,
      execute,
      toJSON: () => ({
        name: generated.name,
        description: generated.description,
        parameters: {
          type: 'object' as const,
          properties: generated.parameters as Record<string, unknown>,
        },
      }),
    };
  }

  private compileImplementation(implementation: string): (params: unknown) => Promise<unknown> {
    return async (params: unknown): Promise<unknown> => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const factory = new Function(`
        "use strict";
        ${implementation}
        return execute;
      `);

      const execute = factory();
      return execute(params);
    };
  }

  private async callLLM(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: number
  ) {
    if (this.llm.complete) {
      return this.llm.complete({ messages, temperature });
    }
    return this.llm.chat({ model: 'default', messages, temperature });
  }
}
