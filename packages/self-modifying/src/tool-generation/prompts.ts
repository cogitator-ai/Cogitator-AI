import type { CapabilityGap, GeneratedTool, ToolValidationResult } from '@cogitator-ai/types';

export const TOOL_GENERATION_SYSTEM_PROMPT = `You are an expert TypeScript developer specializing in creating tools for AI agents.
Your task is to generate safe, efficient, and well-typed tool implementations.

CRITICAL CONSTRAINTS:
1. Generate ONLY pure TypeScript functions - no external dependencies beyond built-in modules
2. All generated code must be self-contained and synchronous where possible
3. Never generate code that accesses file system, network, or system resources unless explicitly requested
4. Always include proper error handling
5. Use Zod for parameter validation when schemas are provided
6. Follow the exact Tool interface structure

OUTPUT FORMAT:
Return a JSON object with:
{
  "name": "tool_name",
  "description": "Clear description of what the tool does",
  "implementation": "// TypeScript code as a string",
  "parameters": { "type": "object", "properties": {...}, "required": [...] },
  "reasoning": "Why this implementation was chosen"
}`;

export function buildGapAnalysisPrompt(
  userIntent: string,
  availableTools: Array<{ name: string; description: string }>,
  failedAttempts?: string[]
): string {
  const toolList = availableTools.map((t) => `- ${t.name}: ${t.description}`).join('\n');

  const failureContext = failedAttempts?.length
    ? `\n\nPrevious failed attempts:\n${failedAttempts.map((f) => `- ${f}`).join('\n')}`
    : '';

  return `Analyze the following user intent and determine if any capabilities are missing from the available tools.

USER INTENT:
${userIntent}

AVAILABLE TOOLS:
${toolList}
${failureContext}

Respond with a JSON object:
{
  "hasGap": boolean,
  "gaps": [
    {
      "id": "unique_gap_id",
      "description": "What capability is missing",
      "requiredCapability": "Specific capability needed",
      "suggestedToolName": "proposed_tool_name",
      "complexity": "simple" | "moderate" | "complex",
      "confidence": 0.0-1.0,
      "reasoning": "Why this gap exists"
    }
  ],
  "canProceed": boolean,
  "alternativeApproach": "If gaps exist but can still proceed, explain how"
}`;
}

export function buildToolGenerationPrompt(
  gap: CapabilityGap,
  existingTools: Array<{ name: string; description: string }>,
  constraints?: {
    maxLines?: number;
    allowedModules?: string[];
    securityLevel?: 'strict' | 'moderate' | 'permissive';
  }
): string {
  const securityRules = {
    strict: `
- NO file system access
- NO network requests
- NO eval() or Function constructor
- NO dynamic imports
- NO process or child_process access
- ONLY pure computation`,
    moderate: `
- File system access ONLY if explicitly requested
- Network requests ONLY to whitelisted domains
- NO eval() or Function constructor
- NO dynamic imports`,
    permissive: `
- File system access allowed with path validation
- Network requests allowed
- NO eval() or Function constructor`,
  };

  const security = constraints?.securityLevel || 'strict';
  const maxLines = constraints?.maxLines || 100;

  return `Generate a TypeScript tool implementation for the following capability gap.

CAPABILITY GAP:
- Description: ${gap.description}
- Required: ${gap.requiredCapability}
- Suggested name: ${gap.suggestedToolName}
- Complexity: ${gap.complexity}

EXISTING TOOLS (avoid duplication):
${existingTools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}

CONSTRAINTS:
- Maximum ${maxLines} lines of code
- Security level: ${security}
${securityRules[security]}
${constraints?.allowedModules ? `- Allowed modules: ${constraints.allowedModules.join(', ')}` : ''}

Generate a complete, self-contained tool following this exact structure:
{
  "name": "${gap.suggestedToolName}",
  "description": "Clear description",
  "implementation": "async function execute(params: Params): Promise<Result> { ... }",
  "parameters": {
    "type": "object",
    "properties": { ... },
    "required": [ ... ]
  },
  "reasoning": "Implementation rationale"
}`;
}

export function buildToolValidationPrompt(
  tool: GeneratedTool,
  testCases: Array<{ input: unknown; expectedBehavior: string }>
): string {
  return `Validate the following generated tool for correctness, safety, and edge cases.

TOOL:
Name: ${tool.name}
Description: ${tool.description}

IMPLEMENTATION:
\`\`\`typescript
${tool.implementation}
\`\`\`

PARAMETERS:
${JSON.stringify(tool.parameters, null, 2)}

TEST CASES TO CONSIDER:
${testCases.map((tc, i) => `${i + 1}. Input: ${JSON.stringify(tc.input)} - Expected: ${tc.expectedBehavior}`).join('\n')}

Analyze and respond with:
{
  "isValid": boolean,
  "securityIssues": ["list of security concerns"],
  "logicIssues": ["list of logic/correctness issues"],
  "edgeCases": ["unhandled edge cases"],
  "suggestions": ["improvement suggestions"],
  "testResults": [
    { "testCase": 1, "wouldPass": boolean, "reason": "explanation" }
  ],
  "overallScore": 0.0-1.0,
  "recommendation": "approve" | "revise" | "reject"
}`;
}

export function buildToolImprovementPrompt(
  tool: GeneratedTool,
  validationResult: ToolValidationResult,
  iteration: number
): string {
  const issues = [
    ...validationResult.securityIssues.map((i) => `[SECURITY] ${i}`),
    ...validationResult.logicIssues.map((i) => `[LOGIC] ${i}`),
    ...validationResult.edgeCases.map((i) => `[EDGE CASE] ${i}`),
  ];

  return `Improve the following tool based on validation feedback.

ITERATION: ${iteration}

CURRENT TOOL:
Name: ${tool.name}
Description: ${tool.description}

CURRENT IMPLEMENTATION:
\`\`\`typescript
${tool.implementation}
\`\`\`

ISSUES TO FIX:
${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

SUGGESTIONS:
${validationResult.suggestions.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}

Generate an improved implementation that addresses ALL issues.
Respond with the same JSON format as before:
{
  "name": "${tool.name}",
  "description": "Updated description if needed",
  "implementation": "// Improved TypeScript code",
  "parameters": { ... },
  "reasoning": "What was changed and why"
}`;
}

export function parseGapAnalysisResponse(response: string): {
  hasGap: boolean;
  gaps: CapabilityGap[];
  canProceed: boolean;
  alternativeApproach?: string;
} {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { hasGap: false, gaps: [], canProceed: true };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      hasGap: Boolean(parsed.hasGap),
      gaps: Array.isArray(parsed.gaps)
        ? parsed.gaps.map((g: Record<string, unknown>, idx: number) => ({
            id: String(g.id || `gap_${idx}`),
            description: String(g.description || ''),
            requiredCapability: String(g.requiredCapability || ''),
            suggestedToolName: String(g.suggestedToolName || `generated_tool_${idx}`),
            complexity: (['simple', 'moderate', 'complex'].includes(String(g.complexity))
              ? g.complexity
              : 'moderate') as 'simple' | 'moderate' | 'complex',
            confidence: typeof g.confidence === 'number' ? g.confidence : 0.5,
            reasoning: String(g.reasoning || ''),
          }))
        : [],
      canProceed: Boolean(parsed.canProceed),
      alternativeApproach: parsed.alternativeApproach
        ? String(parsed.alternativeApproach)
        : undefined,
    };
  } catch {
    return { hasGap: false, gaps: [], canProceed: true };
  }
}

export function parseToolGenerationResponse(response: string): GeneratedTool | null {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.name || !parsed.implementation) {
      return null;
    }

    return {
      id: `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(parsed.name),
      description: String(parsed.description || ''),
      implementation: String(parsed.implementation),
      parameters: parsed.parameters || { type: 'object', properties: {} },
      createdAt: new Date(),
      version: 1,
      status: 'pending_validation',
      metadata: {
        reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
      },
    };
  } catch {
    return null;
  }
}

export function parseValidationResponse(response: string): ToolValidationResult | null {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      isValid: Boolean(parsed.isValid),
      securityIssues: Array.isArray(parsed.securityIssues) ? parsed.securityIssues.map(String) : [],
      logicIssues: Array.isArray(parsed.logicIssues) ? parsed.logicIssues.map(String) : [],
      edgeCases: Array.isArray(parsed.edgeCases) ? parsed.edgeCases.map(String) : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
      testResults: Array.isArray(parsed.testResults)
        ? parsed.testResults.map((tr: Record<string, unknown>) => ({
            input: tr.input,
            output: tr.output,
            passed: Boolean(tr.wouldPass ?? tr.passed),
            error: tr.error ? String(tr.error) : undefined,
          }))
        : [],
      overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : 0,
    };
  } catch {
    return null;
  }
}
