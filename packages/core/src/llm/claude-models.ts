import type { ChatResponse } from '@cogitator-ai/types';
import { getLogger } from '../logger';

/**
 * Family and version parsed from a Claude model id. `major` is null for
 * unversioned ids such as `claude-mythos-preview`.
 */
export interface ClaudeModelVersion {
  family: string;
  major: number | null;
  minor: number;
}

/**
 * How a Claude model treats `temperature` / `top_p`:
 * - `unrestricted`: both may be sent (Claude 3.x and older, non-Claude models)
 * - `exclusive`: at most one of them per request (Claude 4.0 – 4.6)
 * - `unsupported`: non-default values are rejected with HTTP 400 (Claude 4.7+, 5.x, Fable, Mythos)
 */
export type ClaudeSamplingPolicy = 'unrestricted' | 'exclusive' | 'unsupported';

export interface SamplingParams {
  temperature?: number;
  topP?: number;
}

interface ModelVersionThreshold {
  major: number;
  minor: number;
}

const ALWAYS_CURRENT_FAMILIES: ReadonlySet<string> = new Set(['fable', 'mythos']);
const SAMPLING_UNSUPPORTED_FROM: ModelVersionThreshold = { major: 4, minor: 7 };
const STRUCTURED_OUTPUT_FROM: ModelVersionThreshold = { major: 4, minor: 5 };
const BEDROCK_STRUCTURED_OUTPUT_UNTIL: ModelVersionThreshold = { major: 4, minor: 7 };
const FORCED_TOOL_CHOICE_REJECTED_FROM: Readonly<Record<string, ModelVersionThreshold>> = {
  fable: { major: 5, minor: 1 },
  mythos: { major: 5, minor: 1 },
};
const DEFAULT_FORCED_TOOL_CHOICE_REJECTED_FROM: ModelVersionThreshold = { major: 5, minor: 5 };

const CLAUDE_ID_PREFIX = 'claude-';
const CLAUDE_ID_CHAR = /[a-z0-9.@:[\]-]/i;
const CLAUDE_ID_REST_START = /[a-z0-9]/i;
const CLAUDE_ID_BOUNDARIES = './:';
const NAMED_FAMILY_PATTERN = /^([a-z]+)(?:-(\d+)(?:[-.](\d{1,2})(?!\d))?)?/i;
const LEGACY_PATTERN = /^(\d+)(?:[-.](\d))?-([a-z]+)/i;

/**
 * Parse a Claude model id from the Anthropic API, Vertex AI or Amazon Bedrock
 * (including cross-region inference profiles and ARNs).
 *
 * @example
 * parseClaudeModelId('claude-sonnet-5-5');                      // { family: 'sonnet', major: 5, minor: 5 }
 * parseClaudeModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0'); // { family: 'haiku', major: 4, minor: 5 }
 * parseClaudeModelId('claude-3-5-sonnet-20241022');             // { family: 'sonnet', major: 3, minor: 5 }
 * parseClaudeModelId('gpt-4o');                                 // null
 */
export function parseClaudeModelId(modelId: string): ClaudeModelVersion | null {
  const rest = claudeIdRest(modelId.trim());
  if (rest === null) return null;

  const legacy = LEGACY_PATTERN.exec(rest);
  if (legacy) {
    return {
      family: legacy[3].toLowerCase(),
      major: Number(legacy[1]),
      minor: legacy[2] === undefined ? 0 : Number(legacy[2]),
    };
  }

  const named = NAMED_FAMILY_PATTERN.exec(rest);
  if (!named) return null;
  return {
    family: named[1].toLowerCase(),
    major: named[2] === undefined ? null : Number(named[2]),
    minor: named[3] === undefined ? 0 : Number(named[3]),
  };
}

/**
 * Text after the leftmost `claude-` that starts the id or follows `.`, `/` or `:`
 * and is followed only by model-id characters up to the end.
 */
function claudeIdRest(modelId: string): string | null {
  let tailStart = modelId.length;
  while (tailStart > 0 && CLAUDE_ID_CHAR.test(modelId[tailStart - 1])) tailStart--;
  const restOffset = CLAUDE_ID_PREFIX.length;
  for (let i = tailStart; i + restOffset < modelId.length; i++) {
    if (i > 0 && !CLAUDE_ID_BOUNDARIES.includes(modelId[i - 1])) continue;
    if (modelId.slice(i, i + restOffset).toLowerCase() !== CLAUDE_ID_PREFIX) continue;
    if (CLAUDE_ID_REST_START.test(modelId[i + restOffset])) return modelId.slice(i + restOffset);
  }
  return null;
}

function isAtLeast(version: ClaudeModelVersion, threshold: ModelVersionThreshold): boolean {
  if (version.major === null) return false;
  return (
    version.major > threshold.major ||
    (version.major === threshold.major && version.minor >= threshold.minor)
  );
}

export function getClaudeSamplingPolicy(modelId: string): ClaudeSamplingPolicy {
  const version = parseClaudeModelId(modelId);
  if (!version) return 'unrestricted';

  if (ALWAYS_CURRENT_FAMILIES.has(version.family)) return 'unsupported';
  if (version.major === null) return 'unrestricted';
  if (isAtLeast(version, SAMPLING_UNSUPPORTED_FROM)) return 'unsupported';
  return version.major >= 4 ? 'exclusive' : 'unrestricted';
}

/**
 * Whether `tool_choice` `any` / `tool` is accepted. Claude Opus 5.5, Sonnet 5.5,
 * Fable 5.1 and Mythos 5.1 (and later) reject forced tool use with HTTP 400;
 * only `auto` and `none` remain. Non-Claude ids are assumed to support it.
 */
export function supportsForcedToolChoice(modelId: string): boolean {
  const version = parseClaudeModelId(modelId);
  if (!version) return true;
  const threshold =
    FORCED_TOOL_CHOICE_REJECTED_FROM[version.family] ?? DEFAULT_FORCED_TOOL_CHOICE_REJECTED_FROM;
  return !isAtLeast(version, threshold);
}

/**
 * Whether the Claude API accepts `output_config.format` (JSON structured outputs):
 * Claude 4.5 and later, plus every Fable / Mythos model.
 */
export function supportsNativeStructuredOutput(modelId: string): boolean {
  const version = parseClaudeModelId(modelId);
  if (!version) return false;
  return ALWAYS_CURRENT_FAMILIES.has(version.family) || isAtLeast(version, STRUCTURED_OUTPUT_FROM);
}

/**
 * Whether Bedrock Converse accepts `outputConfig.textFormat` for a Claude model.
 * Bedrock serves structured outputs only for Claude 4.5 – 4.6 (the legacy
 * integration); Claude 4.7+, Fable and Mythos reject it there.
 */
export function supportsBedrockStructuredOutput(modelId: string): boolean {
  const version = parseClaudeModelId(modelId);
  if (!version || ALWAYS_CURRENT_FAMILIES.has(version.family)) return false;
  return (
    isAtLeast(version, STRUCTURED_OUTPUT_FROM) &&
    !isAtLeast(version, BEDROCK_STRUCTURED_OUTPUT_UNTIL)
  );
}

/**
 * How a Claude model takes extended thinking:
 * - `adaptive`: `thinking: { type: 'adaptive' }` plus `output_config.effort` (Claude 4.6+, 5.x, Fable, Mythos)
 * - `budget`: `thinking: { type: 'enabled', budget_tokens }` (Claude 3.7 Sonnet, 4.0 – 4.5)
 * - `none`: no extended thinking
 */
export type ClaudeThinkingMode = 'adaptive' | 'budget' | 'none';

const ADAPTIVE_THINKING_FROM: ModelVersionThreshold = { major: 4, minor: 6 };
const BUDGET_THINKING_FROM: ModelVersionThreshold = { major: 3, minor: 7 };

export function getClaudeThinkingMode(modelId: string): ClaudeThinkingMode {
  const version = parseClaudeModelId(modelId);
  if (!version) return 'none';
  if (ALWAYS_CURRENT_FAMILIES.has(version.family)) return 'adaptive';
  if (version.major === null) return 'none';
  if (isAtLeast(version, ADAPTIVE_THINKING_FROM) && version.family !== 'haiku') return 'adaptive';
  if (isAtLeast(version, BUDGET_THINKING_FROM)) return 'budget';
  return 'none';
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Effort levels `output_config.effort` accepts: all five from Claude 4.7 on
 * (and on 5.x, Fable, Mythos), no `xhigh` on 4.6, `low`–`high` on Opus 4.5,
 * none on other models.
 */
export function getClaudeEffortLevels(modelId: string): readonly ClaudeEffort[] {
  const version = parseClaudeModelId(modelId);
  if (!version) return [];
  const all: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (ALWAYS_CURRENT_FAMILIES.has(version.family)) return all;
  if (version.major === null || version.family === 'haiku') return [];
  if (isAtLeast(version, { major: 4, minor: 7 })) return all;
  if (isAtLeast(version, { major: 4, minor: 6 })) return ['low', 'medium', 'high', 'max'];
  if (version.family === 'opus' && isAtLeast(version, { major: 4, minor: 5 })) {
    return ['low', 'medium', 'high'];
  }
  return [];
}

/**
 * How a Claude model with adaptive thinking turns thinking off:
 * - `disabled`: `thinking: { type: 'disabled' }` (4.6 – 4.8, Sonnet 5, Opus 5 at effort `high` or below)
 * - `between_tools`: `thinking: { type: 'between_tools' }` (Sonnet 5.5 and later)
 * - `never`: it cannot; the lowest effort is the closest (Opus 5.5+, Fable, Mythos)
 */
export type ClaudeThinkingOff = 'disabled' | 'between_tools' | 'never';

export function getClaudeThinkingOff(modelId: string): ClaudeThinkingOff {
  const version = parseClaudeModelId(modelId);
  if (!version || ALWAYS_CURRENT_FAMILIES.has(version.family)) return 'never';
  if (version.family === 'opus' && isAtLeast(version, { major: 5, minor: 5 })) return 'never';
  if (version.family === 'sonnet' && isAtLeast(version, { major: 5, minor: 5 })) {
    return 'between_tools';
  }
  return 'disabled';
}

export type WarnOnce = (key: string, message: string, context?: Record<string, unknown>) => void;

/**
 * Create a logger that emits each distinct warning key only once.
 */
export function createWarnOnce(): WarnOnce {
  const emitted = new Set<string>();
  return (key, message, context) => {
    if (emitted.has(key)) return;
    emitted.add(key);
    getLogger().warn(message, context);
  };
}

/**
 * Drop sampling parameters the target Claude model would reject.
 * For `exclusive` models `temperature` wins over `topP`.
 */
export function resolveClaudeSampling(modelId: string, params: SamplingParams): SamplingParams {
  const result: SamplingParams = {};

  switch (getClaudeSamplingPolicy(modelId)) {
    case 'unsupported':
      return result;
    case 'exclusive':
      if (params.temperature !== undefined) result.temperature = params.temperature;
      else if (params.topP !== undefined) result.topP = params.topP;
      return result;
    case 'unrestricted':
      if (params.temperature !== undefined) result.temperature = params.temperature;
      if (params.topP !== undefined) result.topP = params.topP;
      return result;
  }
}

/**
 * Map a Claude stop reason (Messages API or Bedrock Converse) to a finish reason.
 * `pause_turn` maps to `length`: the turn is incomplete and must be continued.
 */
export function mapClaudeStopReason(
  reason: string | null | undefined
): ChatResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'pause_turn':
      return 'length';
    case 'refusal':
    case 'guardrail_intervened':
    case 'content_filtered':
    case 'malformed_model_output':
    case 'malformed_tool_use':
      return 'error';
    default:
      return 'stop';
  }
}

/**
 * System-prompt instruction used when forced tool use has to be downgraded to `auto`.
 */
export function forcedToolChoiceInstruction(toolName?: string): string {
  return toolName
    ? `You must respond by calling the "${toolName}" tool.`
    : 'You must respond by calling one of the provided tools.';
}

/**
 * System-prompt instruction for JSON output when the provider cannot enforce a schema natively.
 */
export function jsonOutputInstruction(schema?: Record<string, unknown>): string {
  if (!schema) {
    return 'You must respond with valid JSON only. Do not include any text before or after the JSON object.';
  }
  return [
    'You must respond with valid JSON only, conforming to the JSON schema below.',
    'Do not include any text before or after the JSON.',
    JSON.stringify(schema),
  ].join('\n');
}
