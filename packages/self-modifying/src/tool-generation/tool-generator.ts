import type {
  Tool,
  ToolSchema,
  LLMBackend,
  CapabilityGap,
  GeneratedTool,
  ToolValidationResult,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import { z, type ZodType } from 'zod';
import { ToolValidator } from './tool-validator';
import { ToolSandbox, type SandboxTestCase } from './tool-sandbox';
import { llmChat } from '../utils/llm-helper';
import {
  TOOL_GENERATION_SYSTEM_PROMPT,
  buildToolGenerationPrompt,
  buildToolImprovementPrompt,
  parseToolGenerationResponse,
} from './prompts';

export interface ToolGeneratorOptions {
  llm: LLMBackend;
  config: ToolSelfGenerationConfig;
  /** Model the LLM calls use, without the provider prefix of the backend */
  model: string;
  /**
   * Upper bound on the output tokens of each generation, improvement and review call.
   * Unset leaves the backend default.
   */
  maxTokens?: number;
}

export interface GenerateOptions {
  parameters?: Record<string, unknown>;
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
  private readonly model: string;
  private readonly maxTokens?: number;
  private readonly validator: ToolValidator;
  private readonly sandbox: ToolSandbox;

  constructor(options: ToolGeneratorOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.validator = new ToolValidator({
      llm: options.llm,
      config: options.config,
      model: this.model,
      maxTokens: options.maxTokens,
    });
    this.sandbox = new ToolSandbox(options.config.sandboxConfig);
  }

  async generate(
    gap: CapabilityGap,
    existingTools: Tool[],
    testCases?: SandboxTestCase[],
    options: GenerateOptions = {}
  ): Promise<GenerationResult> {
    let currentTool: GeneratedTool | null = null;
    let validationResult: ToolValidationResult | null = null;
    let iterations = 0;

    const maxIterations = this.config.maxIterationsPerTool || 3;

    while (iterations < maxIterations) {
      iterations++;

      try {
        if (currentTool === null) {
          currentTool = await this.generateInitial(gap, existingTools, options.parameters);
        } else if (validationResult) {
          const improved = await this.improve(currentTool, validationResult, iterations);
          if (!improved) {
            continue;
          }
          currentTool = improved;
        }

        if (!currentTool) {
          continue;
        }

        currentTool.description = describeTool(currentTool.description, gap);

        if (options.parameters) {
          currentTool.parameters = options.parameters;
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
    parameters: Record<string, unknown>
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

    const result = await this.generate(
      gap,
      [],
      undefined,
      Object.keys(parameters).length > 0
        ? { parameters: { type: 'object', properties: parameters } }
        : {}
    );

    return result.success ? result.tool : null;
  }

  private async generateInitial(
    gap: CapabilityGap,
    existingTools: Tool[],
    parameters?: Record<string, unknown>
  ): Promise<GeneratedTool | null> {
    const toolSummaries = existingTools.map((t) => ({
      name: t.name,
      description: t.description,
    }));

    const prompt = buildToolGenerationPrompt(gap, toolSummaries, {
      maxLines: 100,
      securityLevel: 'strict',
      allowedModules: this.config.sandboxConfig?.allowedModules,
      parameters,
    });

    const content = await llmChat(
      this.llm,
      [
        { role: 'system', content: TOOL_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { model: this.model, temperature: 0.4, maxTokens: this.maxTokens }
    );

    const tool = parseToolGenerationResponse(content);

    if (tool) {
      tool.metadata = {
        ...tool.metadata,
        gapId: gap.id,
        capability: gap.requiredCapability,
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

    const content = await llmChat(
      this.llm,
      [
        { role: 'system', content: TOOL_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { model: this.model, temperature: 0.3, maxTokens: this.maxTokens }
    );

    const improved = parseToolGenerationResponse(content);

    if (improved) {
      improved.description ||= tool.description;
      improved.id = tool.id;
      improved.name = tool.name;
      improved.createdAt = tool.createdAt;
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
    const sandbox = this.sandbox;
    const tool = generated;
    const paramSchema = buildZodSchema(generated.parameters);
    const jsonSchema = toToolJsonSchema(generated.parameters);

    const execute = async (params: unknown): Promise<unknown> => {
      const parsed = paramSchema.safeParse(params);
      if (!parsed.success) {
        throw new Error(
          `Invalid parameters: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        );
      }

      const result = await sandbox.execute(tool, parsed.data);
      if (!result.success) {
        throw new Error(result.error ?? 'Tool execution failed');
      }
      return result.result;
    };

    return {
      name: generated.name,
      description: generated.description,
      parameters: paramSchema as ZodType<unknown>,
      execute,
      toJSON: () => ({
        name: generated.name,
        description: generated.description,
        parameters: jsonSchema,
      }),
    };
  }
}

/**
 * What an agent is told the tool does. The model writes it, but a copy of the gap text
 * ("no tool can ...") or an empty one would make the next gap analysis think the
 * capability is still missing, so those fall back to the capability the tool provides.
 */
function describeTool(description: string, gap: CapabilityGap): string {
  const written = description.trim();
  const echoesGap = normalize(written) === normalize(gap.description);
  if (written && !echoesGap) return written;
  return gap.requiredCapability.trim() || gap.description.trim() || written;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toToolJsonSchema(parameters: Record<string, unknown>): ToolSchema['parameters'] {
  const properties =
    parameters.type === 'object' &&
    parameters.properties &&
    typeof parameters.properties === 'object' &&
    !Array.isArray(parameters.properties)
      ? (parameters.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((key): key is string => typeof key === 'string')
    : [];

  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

function buildZodSchema(parameters: Record<string, unknown>): ZodType<unknown> {
  if (
    parameters.type !== 'object' ||
    !parameters.properties ||
    typeof parameters.properties !== 'object'
  ) {
    return z.record(z.string(), z.unknown());
  }

  const properties = parameters.properties as Record<string, Record<string, unknown>>;
  const required = Array.isArray(parameters.required)
    ? new Set(parameters.required as string[])
    : new Set<string>();

  const shape: Record<string, ZodType<unknown>> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    let fieldSchema: ZodType<unknown> = jsonTypeToZod(propSchema.type as string | undefined);

    if (!required.has(key)) {
      fieldSchema = fieldSchema.optional() as ZodType<unknown>;
    }

    shape[key] = fieldSchema;
  }

  if (Object.keys(shape).length === 0) {
    return z.record(z.string(), z.unknown());
  }

  return z.object(shape).passthrough() as ZodType<unknown>;
}

function jsonTypeToZod(type?: string): ZodType<unknown> {
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(z.unknown());
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
