/**
 * The core's own plugin: the built-in LLM providers, registered through the same
 * `PluginContext.registerLLMBackend` a third-party backend uses
 */

import {
  LLM_PROVIDERS,
  type CogitatorConfig,
  type LLMPlugin,
  type PluginDefinition,
} from '@cogitator-ai/types';
import { createLLMBackend } from '../llm/index';

/** The plugin of the built-in providers of a runtime with `llm` */
export function corePlugin(llm: () => CogitatorConfig['llm']): PluginDefinition {
  return {
    name: 'cogitator',
    description: 'The built-in LLM providers of the runtime',
    activate(context) {
      for (const provider of LLM_PROVIDERS) {
        const plugin: LLMPlugin = {
          provider,
          metadata: { name: provider, description: `The built-in ${provider} backend` },
          factory: () => createLLMBackend(provider, llm()),
        };
        context.registerLLMBackend(plugin);
      }
    },
  };
}
