import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';
import { readEnv } from '../utils/env';

const IMAGE_GENERATION_TIMEOUT_MS = 180_000;

const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare';

const IMAGE_SIZES = [
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '1792x1024',
  '1024x1792',
] as const;

const IMAGE_QUALITIES = [
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'standard',
  'hd',
] as const;

const IMAGE_STYLES = ['vivid', 'natural'] as const;

const IMAGE_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const;

const IMAGE_BACKGROUNDS = ['auto', 'transparent', 'opaque'] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageStyle = (typeof IMAGE_STYLES)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type ImageBackground = (typeof IMAGE_BACKGROUNDS)[number];

export interface GenerateImageConfig {
  apiKey?: string;
  baseUrl?: string;
  /**
   * Image model. Defaults to `gpt-image-2.5-flare`. `dall-e-*` ids keep the legacy
   * request shape (URL response, `style`) for OpenAI-compatible servers that still serve them.
   */
  model?: string;
}

export interface GeneratedImage {
  /** Hosted image URL, returned only by legacy `dall-e-*` compatible endpoints */
  url?: string;
  /** Base64-encoded image bytes, returned by `gpt-image-*` models */
  imageBase64?: string;
  mimeType: string;
  revisedPrompt?: string;
  model: string;
  size: ImageSize;
  quality: ImageQuality;
  style?: ImageStyle;
}

interface ImageGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
  output_format?: ImageOutputFormat;
}

const LEGACY_QUALITY_MAP: Partial<Record<ImageQuality, ImageQuality>> = {
  standard: 'medium',
  hd: 'high',
};

function isLegacyDalleModel(model: string): boolean {
  return model.startsWith('dall-e');
}

function buildRequestBody(
  model: string,
  input: {
    prompt: string;
    size?: ImageSize;
    quality?: ImageQuality;
    style?: ImageStyle;
    outputFormat?: ImageOutputFormat;
    background?: ImageBackground;
  }
): { body: Record<string, unknown>; size: ImageSize; quality: ImageQuality; style?: ImageStyle } {
  if (isLegacyDalleModel(model)) {
    const size = input.size && input.size !== 'auto' ? input.size : '1024x1024';
    const quality = input.quality === 'hd' ? 'hd' : 'standard';
    const style = input.style ?? 'vivid';
    return {
      body: { model, prompt: input.prompt, n: 1, size, quality, style, response_format: 'url' },
      size,
      quality,
      style,
    };
  }

  const size = input.size ?? 'auto';
  const quality = (input.quality && LEGACY_QUALITY_MAP[input.quality]) ?? input.quality ?? 'auto';
  return {
    body: {
      model,
      prompt: input.prompt,
      n: 1,
      size,
      quality,
      ...(input.outputFormat && { output_format: input.outputFormat }),
      ...(input.background && { background: input.background }),
    },
    size,
    quality,
  };
}

export function createGenerateImageTool(config: GenerateImageConfig = {}) {
  const { apiKey, baseUrl = 'https://api.openai.com/v1', model = DEFAULT_IMAGE_MODEL } = config;

  return tool({
    name: 'generateImage',
    description:
      'Generate an image from a text description with OpenAI image models. Returns the image as base64 data.',
    parameters: z.object({
      prompt: z
        .string()
        .describe(
          'Detailed description of the image to generate. Be specific about style, composition, colors, etc.'
        ),
      size: z
        .enum(IMAGE_SIZES)
        .optional()
        .describe(
          'Image dimensions. 1024x1024 is square, 1536x1024 landscape, 1024x1536 portrait, "auto" lets the model choose.'
        ),
      quality: z
        .enum(IMAGE_QUALITIES)
        .optional()
        .describe(
          'Rendering quality: low, medium, high, xhigh, max or auto. Legacy "standard" maps to medium and "hd" to high.'
        ),
      style: z
        .enum(IMAGE_STYLES)
        .optional()
        .describe(
          'Legacy DALL-E style. Ignored by gpt-image models; describe the style in the prompt.'
        ),
      outputFormat: z
        .enum(IMAGE_OUTPUT_FORMATS)
        .optional()
        .describe('Image file format (default: png)'),
      background: z
        .enum(IMAGE_BACKGROUNDS)
        .optional()
        .describe('Background handling. "transparent" requires png or webp output.'),
    }),
    sideEffects: ['network', 'external'],
    execute: async (
      { prompt, size, quality, style, outputFormat, background },
      context
    ): Promise<GeneratedImage> => {
      const key = apiKey || readEnv('OPENAI_API_KEY');
      if (!key) {
        throw new Error(
          'OpenAI API key required for image generation. Set OPENAI_API_KEY environment variable.'
        );
      }

      const request = buildRequestBody(model, {
        prompt,
        size,
        quality,
        style,
        outputFormat,
        background,
      });

      const abort = createLinkedAbortController(context?.signal, IMAGE_GENERATION_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(request.body),
          signal: abort.signal,
        });
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          throw new Error(
            getAbortErrorMessage('Image generation request', abort, IMAGE_GENERATION_TIMEOUT_MS),
            { cause: err }
          );
        }
        throw err;
      } finally {
        abort.cleanup();
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Image generation failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as ImageGenerationResponse;
      const image = data.data?.[0];

      if (!image || (!image.b64_json && !image.url)) {
        throw new Error('Image generation failed: response contained no image');
      }

      const format = data.output_format ?? outputFormat ?? 'png';

      return {
        ...(image.url && { url: image.url }),
        ...(image.b64_json && { imageBase64: image.b64_json }),
        mimeType: `image/${format}`,
        revisedPrompt: image.revised_prompt,
        model,
        size: request.size,
        quality: request.quality,
        ...(request.style && { style: request.style }),
      };
    },
  });
}

export const generateImageSchema = z.object({
  prompt: z.string(),
  size: z.enum(IMAGE_SIZES).optional(),
  quality: z.enum(IMAGE_QUALITIES).optional(),
  style: z.enum(IMAGE_STYLES).optional(),
  outputFormat: z.enum(IMAGE_OUTPUT_FORMATS).optional(),
  background: z.enum(IMAGE_BACKGROUNDS).optional(),
});

export type GenerateImageInput = z.infer<typeof generateImageSchema>;
