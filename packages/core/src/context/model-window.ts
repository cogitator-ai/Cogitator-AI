import { getModel } from '@cogitator-ai/models';
import { parseModel } from '../llm/index';

/**
 * The context window of `modelString` in tokens: from the model registry, else from what its
 * name says of its family, else 8192.
 */
export function modelContextWindow(modelString: string): number {
  const { model: modelId } = parseModel(modelString);
  const modelInfo = getModel(modelId);

  if (modelInfo?.contextWindow) {
    return modelInfo.contextWindow;
  }

  const lowerId = modelId.toLowerCase();
  if (/gpt-6|gpt-5\.(?:[5-9]|4(?!-(?:mini|nano)))/.test(lowerId)) return 1050000;
  if (lowerId.includes('gpt-5')) return 400000;
  if (lowerId.includes('gpt-4o')) return 128000;
  if (lowerId.includes('gpt-4.1')) return 1047576;
  if (lowerId.includes('gpt-4')) return 8192;
  if (lowerId.includes('gpt-3.5')) return 16385;
  if (
    /claude-(?:fable|mythos)|claude-(?:opus|sonnet)-[5-9]|claude-opus-4-[6-9]|claude-sonnet-4-6/.test(
      lowerId
    )
  )
    return 1000000;
  if (
    lowerId.includes('claude-3') ||
    lowerId.includes('claude-sonnet') ||
    lowerId.includes('claude-opus') ||
    lowerId.includes('claude-haiku')
  )
    return 200000;
  if (lowerId.includes('claude-2')) return 100000;
  if (lowerId.includes('gemini-pro')) return 1000000;
  if (/gemini-(?:[3-9]|2\.5)/.test(lowerId)) return 1048576;
  if (lowerId.includes('llama')) return 8192;
  if (lowerId.includes('mistral')) return 32768;

  return 8192;
}
