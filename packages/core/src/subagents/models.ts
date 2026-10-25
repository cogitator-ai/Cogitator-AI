/** Claude Code's model aliases, which a definition may name without `llm.modelAliases` */
export const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

/** What a definition's `model` resolves to, see {@link resolveDefinitionModel} */
export type ResolvedModel =
  { inherit: true; warning?: string } | { inherit: false; model: string; warning?: string };

/**
 * The model a subagent's or a command's `model` names: `inherit` (or nothing) keeps the model of
 * the agent that runs it, a key of `aliases` (`llm.modelAliases`) its value, a Claude Code alias
 * without an entry the agent's model with a warning, a Claude model id without a provider
 * (`claude-opus-5-5`) the Anthropic one, and a model as `provider/model` itself. A bare name of
 * another kind runs on the default provider, with a warning
 */
export function resolveDefinitionModel(
  model: string | undefined,
  aliases: Readonly<Record<string, string>> | undefined
): ResolvedModel {
  if (model === undefined || model === 'inherit') return { inherit: true };
  const alias = aliases?.[model];
  if (alias !== undefined) return { inherit: false, model: alias };
  if ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(model)) {
    return {
      inherit: true,
      warning: `Model "${model}" is a Claude Code alias llm.modelAliases does not name: the agent's model is used`,
    };
  }
  if (model.includes('/')) return { inherit: false, model };
  if (/^claude-/i.test(model)) return { inherit: false, model: `anthropic/${model}` };
  return {
    inherit: false,
    model,
    warning: `Model "${model}" names no provider, it runs on llm.defaultProvider`,
  };
}
