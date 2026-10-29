import type { LiteLLMModelData } from './types';
import type { OpenRouterModelEntry } from './openrouter-catalogue';
import snapshot from './data/litellm-snapshot.json' with { type: 'json' };
import openRouterSnapshot from './data/openrouter-snapshot.json' with { type: 'json' };

/** The bundled copy of the LiteLLM catalogue: where it came from, when, and its models. */
export interface LiteLLMSnapshot {
  source: string;
  /** The catalogue's license, MIT, in full */
  license: string;
  /** The day the copy was made, `YYYY-MM-DD` */
  fetchedAt: string;
  models: LiteLLMModelData;
}

export const LITELLM_SNAPSHOT: LiteLLMSnapshot = snapshot;

/** The bundled copy of OpenRouter's model list: where it came from, when, and its priced text models. */
export interface OpenRouterSnapshot {
  source: string;
  /** The day the copy was made, `YYYY-MM-DD` */
  fetchedAt: string;
  models: OpenRouterModelEntry[];
}

export const OPENROUTER_SNAPSHOT: OpenRouterSnapshot = openRouterSnapshot;
