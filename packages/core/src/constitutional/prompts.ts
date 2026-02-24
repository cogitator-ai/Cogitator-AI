import type {
  ConstitutionalPrinciple,
  HarmScore,
  CritiqueResult,
  HarmCategory,
  Severity,
  Message,
} from '@cogitator-ai/types';

export function buildInputEvaluationPrompt(
  input: string,
  principles: ConstitutionalPrinciple[]
): string {
  const principlesList = principles.map((p) => `- ${p.name}: ${p.description}`).join('\n');

  return `You are a content safety evaluator. Analyze the following user input for potential policy violations.

PRINCIPLES TO CHECK:
${principlesList}

USER INPUT:
"""
${input}
"""

Evaluate whether this input attempts to elicit harmful content. Consider:
1. Is this a legitimate question that happens to touch on sensitive topics?
2. Is there clear malicious intent to generate harmful content?
3. Would answering this request violate any of the listed principles?

Respond in JSON format:
{
  "isHarmful": boolean,
  "harmScores": [
    {
      "category": "violence" | "hate" | "sexual" | "self-harm" | "illegal" | "privacy" | "misinformation" | "manipulation",
      "severity": "low" | "medium" | "high",
      "confidence": number (0-1),
      "principleViolated": "principle-id" | null,
      "reasoning": "brief explanation"
    }
  ]
}

If the input is benign, return: {"isHarmful": false, "harmScores": []}`;
}

export function buildOutputEvaluationPrompt(
  output: string,
  context: Message[],
  principles: ConstitutionalPrinciple[]
): string {
  const principlesList = principles
    .map((p) => `- ${p.name} (${p.id}): ${p.critiquePrompt}`)
    .join('\n');

  const contextStr = context
    .slice(-4)
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : '[complex content]';
      return `[${m.role}]: ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`;
    })
    .join('\n');

  return `You are a content safety evaluator. Analyze the following AI response for policy violations.

PRINCIPLES TO CHECK:
${principlesList}

CONVERSATION CONTEXT:
${contextStr}

AI RESPONSE TO EVALUATE:
"""
${output}
"""

For each principle, determine if the response violates it. Consider the context - some content that seems problematic in isolation may be appropriate given the conversation.

Respond in JSON format:
{
  "isHarmful": boolean,
  "harmScores": [
    {
      "category": "violence" | "hate" | "sexual" | "self-harm" | "illegal" | "privacy" | "misinformation" | "manipulation",
      "severity": "low" | "medium" | "high",
      "confidence": number (0-1),
      "principleViolated": "principle-id",
      "reasoning": "brief explanation"
    }
  ],
  "principlesViolated": ["principle-id", ...]
}

If the response is safe, return: {"isHarmful": false, "harmScores": [], "principlesViolated": []}`;
}

export function buildCritiquePrompt(
  response: string,
  principles: ConstitutionalPrinciple[]
): string {
  const critiques = principles.map((p) => `- ${p.name}: ${p.critiquePrompt}`).join('\n');

  return `You are a thoughtful AI safety reviewer. Critique the following response against these principles:

${critiques}

RESPONSE TO CRITIQUE:
"""
${response}
"""

Provide a thoughtful analysis:
1. Does this response violate any of the listed principles?
2. What specific parts are problematic?
3. How severe are the issues?

Respond in JSON format:
{
  "isHarmful": boolean,
  "critique": "detailed analysis of issues found",
  "harmScores": [
    {
      "category": "violence" | "hate" | "sexual" | "self-harm" | "illegal" | "privacy" | "misinformation" | "manipulation",
      "severity": "low" | "medium" | "high",
      "confidence": number (0-1),
      "principleViolated": "principle-id",
      "reasoning": "why this principle was violated"
    }
  ],
  "principlesViolated": ["principle-id", ...]
}

If no violations found: {"isHarmful": false, "critique": "No issues found", "harmScores": [], "principlesViolated": []}`;
}

export function buildRevisionPrompt(
  response: string,
  critique: CritiqueResult,
  principles: ConstitutionalPrinciple[]
): string {
  const violatedPrinciples = principles
    .filter((p) => critique.principlesViolated.includes(p.id))
    .map((p) => `- ${p.name}: ${p.revisionPrompt}`)
    .join('\n');

  return `You are a helpful AI assistant. Your previous response had some issues that need to be addressed.

ORIGINAL RESPONSE:
"""
${response}
"""

CRITIQUE:
${critique.critique}

REVISION GUIDELINES:
${violatedPrinciples}

Please rewrite the response to:
1. Address the legitimate parts of the user's request
2. Avoid the issues identified in the critique
3. Follow the revision guidelines above
4. Maintain a helpful and respectful tone

Provide ONLY the revised response, no explanations or meta-commentary:`;
}

export function parseEvaluationResponse(content: string): {
  isHarmful: boolean;
  harmScores: HarmScore[];
} {
  const cleaned = content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      isHarmful: Boolean(parsed.isHarmful),
      harmScores: (parsed.harmScores ?? []).map(normalizeHarmScore),
    };
  } catch {
    return { isHarmful: false, harmScores: [] };
  }
}

export function parseCritiqueResponse(content: string): CritiqueResult {
  const cleaned = content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      isHarmful: Boolean(parsed.isHarmful),
      critique: String(parsed.critique ?? ''),
      harmScores: (parsed.harmScores ?? []).map(normalizeHarmScore),
      principlesViolated: Array.isArray(parsed.principlesViolated)
        ? parsed.principlesViolated.filter((p: unknown) => typeof p === 'string')
        : [],
    };
  } catch {
    return {
      isHarmful: false,
      critique: 'Failed to parse critique response',
      harmScores: [],
      principlesViolated: [],
    };
  }
}

function normalizeHarmScore(raw: unknown): HarmScore {
  const obj = raw as Record<string, unknown>;
  return {
    category: normalizeCategory(obj.category),
    severity: normalizeSeverity(obj.severity),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
    principleViolated:
      typeof obj.principleViolated === 'string' ? obj.principleViolated : undefined,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
  };
}

function normalizeCategory(value: unknown): HarmCategory {
  const valid: HarmCategory[] = [
    'violence',
    'hate',
    'sexual',
    'self-harm',
    'illegal',
    'privacy',
    'misinformation',
    'manipulation',
  ];
  return valid.includes(value as HarmCategory) ? (value as HarmCategory) : 'manipulation';
}

function normalizeSeverity(value: unknown): Severity {
  const valid: Severity[] = ['low', 'medium', 'high'];
  return valid.includes(value as Severity) ? (value as Severity) : 'low';
}
