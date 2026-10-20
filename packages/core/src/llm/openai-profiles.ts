import type {
  OpenAICompatibleProfile,
  OpenAICompatibleServer,
  ReasoningEffort,
} from '@cogitator-ai/types';

/** A profile with every field set. */
export type ResolvedOpenAICompatibleProfile = Required<Omit<OpenAICompatibleProfile, 'server'>>;

/**
 * What each known OpenAI-compatible server understands, from its API reference (2026-10):
 * Mistral rejects unknown fields, so it gets neither `stream_options` nor efforts it lacks.
 * Together streams usage without being asked, DeepSeek takes `none`, `low`, `high` and `max`.
 * vLLM keeps `max_tokens`, which every version takes.
 */
export const OPENAI_COMPATIBLE_PROFILES: Readonly<
  Record<OpenAICompatibleServer, ResolvedOpenAICompatibleProfile>
> = {
  openai: { maxTokensField: 'max_completion_tokens', streamUsage: true, reasoningEffort: true },
  generic: { maxTokensField: 'max_tokens', streamUsage: true, reasoningEffort: true },
  vllm: { maxTokensField: 'max_tokens', streamUsage: true, reasoningEffort: true },
  ollama: { maxTokensField: 'max_tokens', streamUsage: true, reasoningEffort: true },
  lmstudio: { maxTokensField: 'max_tokens', streamUsage: true, reasoningEffort: true },
  llamacpp: { maxTokensField: 'max_tokens', streamUsage: true, reasoningEffort: true },
  groq: { maxTokensField: 'max_completion_tokens', streamUsage: true, reasoningEffort: true },
  together: {
    maxTokensField: 'max_tokens',
    streamUsage: false,
    reasoningEffort: ['low', 'medium', 'high'],
  },
  deepseek: {
    maxTokensField: 'max_tokens',
    streamUsage: true,
    reasoningEffort: ['none', 'low', 'high', 'max'],
  },
  mistral: {
    maxTokensField: 'max_tokens',
    streamUsage: false,
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high'],
  },
  openrouter: { maxTokensField: 'max_tokens', streamUsage: true, reasoningEffort: true },
};

/**
 * The profile a backend uses: `profile` by name, or its fields over its `server` preset, or
 * over `fallback`, the provider's own preset.
 */
export function resolveOpenAICompatibleProfile(
  fallback: OpenAICompatibleServer,
  profile?: OpenAICompatibleServer | OpenAICompatibleProfile
): ResolvedOpenAICompatibleProfile {
  if (typeof profile === 'string') return OPENAI_COMPATIBLE_PROFILES[profile];
  const { server, ...fields } = profile ?? {};
  const preset = OPENAI_COMPATIBLE_PROFILES[server ?? fallback];
  return {
    maxTokensField: fields.maxTokensField ?? preset.maxTokensField,
    streamUsage: fields.streamUsage ?? preset.streamUsage,
    reasoningEffort: fields.reasoningEffort ?? preset.reasoningEffort,
  };
}

const EFFORT_ORDER: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * The `reasoning_effort` to send for `effort`: as it is, nothing, or the nearest effort the
 * server takes, the higher one when two are as near.
 */
export function reasoningEffortFor(
  profile: ResolvedOpenAICompatibleProfile,
  effort: ReasoningEffort | undefined
): ReasoningEffort | undefined {
  const accepted = profile.reasoningEffort;
  if (!effort || accepted === false) return undefined;
  if (accepted === true || accepted.includes(effort)) return effort;
  const wanted = EFFORT_ORDER.indexOf(effort);
  let best: ReasoningEffort | undefined;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - wanted);
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        best !== undefined &&
        EFFORT_ORDER.indexOf(candidate) > EFFORT_ORDER.indexOf(best))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
