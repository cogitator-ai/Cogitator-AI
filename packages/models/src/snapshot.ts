import type { LiteLLMModelData } from './types';
import snapshot from './data/litellm-snapshot.json' with { type: 'json' };

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
