import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';

const IMAGE_GENERATION_TIMEOUT_MS = 60_000;

export interface GenerateImageConfig {
  apiKey?: string;
  baseUrl?: string;
}

export function createGenerateImageTool(config: GenerateImageConfig = {}) {
  const { apiKey, baseUrl = 'https://api.openai.com/v1' } = config;

  return tool({
    name: 'generateImage',
    description:
      'Generate an image using DALL-E 3. Creates high-quality images from text descriptions.',
    parameters: z.object({
      prompt: z
        .string()
        .describe(
          'Detailed description of the image to generate. Be specific about style, composition, colors, etc.'
        ),
      size: z
        .enum(['1024x1024', '1792x1024', '1024x1792'])
        .optional()
        .describe('Image dimensions. 1024x1024 is square, others are landscape/portrait.'),
      quality: z
        .enum(['standard', 'hd'])
        .optional()
        .describe('Image quality. "hd" creates more detailed images with finer textures.'),
      style: z
        .enum(['vivid', 'natural'])
        .optional()
        .describe('"vivid" for dramatic/hyper-real images, "natural" for more realistic/subdued.'),
    }),
    sideEffects: ['network', 'external'],
    execute: async ({ prompt, size, quality, style }, context) => {
      const key = apiKey || process.env.OPENAI_API_KEY;
      if (!key) {
        throw new Error(
          'OpenAI API key required for image generation. Set OPENAI_API_KEY environment variable.'
        );
      }

      const abort = createLinkedAbortController(context?.signal, IMAGE_GENERATION_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: 'dall-e-3',
            prompt,
            n: 1,
            size: size || '1024x1024',
            quality: quality || 'standard',
            style: style || 'vivid',
            response_format: 'url',
          }),
          signal: abort.signal,
        });
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          throw new Error(
            getAbortErrorMessage('Image generation request', abort, IMAGE_GENERATION_TIMEOUT_MS)
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

      const data = (await response.json()) as {
        created: number;
        data: Array<{
          url: string;
          revised_prompt?: string;
        }>;
      };

      const image = data.data[0];

      return {
        url: image.url,
        revisedPrompt: image.revised_prompt,
        size: size || '1024x1024',
        quality: quality || 'standard',
        style: style || 'vivid',
      };
    },
  });
}

export const generateImageSchema = z.object({
  prompt: z.string(),
  size: z.enum(['1024x1024', '1792x1024', '1024x1792']).optional(),
  quality: z.enum(['standard', 'hd']).optional(),
  style: z.enum(['vivid', 'natural']).optional(),
});

export type GenerateImageInput = z.infer<typeof generateImageSchema>;
