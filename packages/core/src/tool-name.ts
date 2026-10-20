import { createHash } from 'node:crypto';

/** The longest tool name every LLM provider accepts. */
export const TOOL_NAME_MAX_LENGTH = 64;

const PROVIDER_SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/**
 * Whether every LLM provider accepts `name` as a tool name: letters, digits, `_` and `-`,
 * starting with a letter or `_`, at most 64 characters. This is the strictest of the OpenAI,
 * Anthropic, Gemini and Bedrock rules, so a tool with such a name works with any backend.
 */
export function isProviderSafeToolName(name: string): boolean {
  return PROVIDER_SAFE_NAME.test(name);
}

/**
 * A tool name every LLM provider accepts (see {@link isProviderSafeToolName}). A valid name is
 * kept as it is. Other characters, such as the dots of `admin.list_users` or the spaces of
 * `Research Agent`, become `_`, and a name too long is cut and ends with a hash of the full
 * name, so different names stay different.
 */
export function normalizeToolName(name: string): string {
  if (PROVIDER_SAFE_NAME.test(name)) return name;
  let safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!/^[a-zA-Z_]/.test(safe)) safe = `_${safe}`;
  if (safe.length <= TOOL_NAME_MAX_LENGTH) return safe;
  return withNameHash(safe, name);
}

/**
 * Provider-safe names for a set of names, in the same order, kept distinct: two names that
 * normalize to the same one (`a.b` and `a_b`) are told apart by a hash of the original name on
 * each one that was changed.
 */
export function normalizeToolNames(names: readonly string[]): string[] {
  const normalized = names.map(normalizeToolName);
  const owners = new Map<string, number>();
  for (const name of normalized) owners.set(name, (owners.get(name) ?? 0) + 1);
  return normalized.map((name, index) => {
    const original = names[index]!;
    return (owners.get(name) ?? 0) > 1 && original !== name ? withNameHash(name, original) : name;
  });
}

function withNameHash(safe: string, original: string): string {
  const suffix = `_${createHash('sha256').update(original).digest('hex').slice(0, 8)}`;
  return `${safe.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

/**
 * Throws when an LLM provider would refuse `name` as a tool name, naming the rule and a name
 * that follows it. A refused name otherwise fails only once a run sends it, as a provider error.
 */
export function assertToolName(name: string): void {
  if (typeof name === 'string' && PROVIDER_SAFE_NAME.test(name)) return;
  const shown = typeof name === 'string' ? `"${name}"` : String(name);
  const suggestion =
    typeof name === 'string' && name.length > 0 ? ` For example "${normalizeToolName(name)}".` : '';
  throw new TypeError(
    `Invalid tool name ${shown}: LLM providers accept letters, digits, "_" and "-", starting with a letter or "_", at most ${TOOL_NAME_MAX_LENGTH} characters.${suggestion}`
  );
}
