import { z } from 'zod';
import { tool } from '../tool';
import type { ContentPart, LLMBackend } from '@cogitator-ai/types';

const imageSourceSchema = z.union([
  z.string().url().describe('URL of the image to analyze'),
  z.object({
    data: z.string().describe('Base64 encoded image data'),
    mimeType: z
      .enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
      .describe('MIME type of the image'),
  }),
]);

export interface AnalyzeImageConfig {
  llm: LLMBackend;
  defaultModel?: string;
}

export function createAnalyzeImageTool(config: AnalyzeImageConfig) {
  const { llm, defaultModel = 'gpt-4o' } = config;

  return tool({
    name: 'analyzeImage',
    description:
      'Analyze an image using a vision-capable AI model. Can describe contents, extract text, identify objects, answer questions about the image, and more.',
    parameters: z.object({
      image: imageSourceSchema.describe('The image to analyze - either a URL or base64 data'),
      prompt: z
        .string()
        .optional()
        .describe(
          'Specific question or instruction about the image. Defaults to general description.'
        ),
      detail: z
        .enum(['auto', 'low', 'high'])
        .optional()
        .describe(
          'Level of detail for analysis. "high" uses more tokens but provides better analysis.'
        ),
      model: z.string().optional().describe('Vision model to use. Defaults to gpt-4o.'),
    }),
    execute: async ({ image, prompt, detail, model }) => {
      const content: ContentPart[] = [];

      content.push({
        type: 'text',
        text:
          prompt ||
          'Describe this image in detail. Include any text, objects, people, colors, and notable elements.',
      });

      if (typeof image === 'string') {
        content.push({
          type: 'image_url',
          image_url: {
            url: image,
            detail: detail || 'auto',
          },
        });
      } else {
        content.push({
          type: 'image_base64',
          image_base64: {
            data: image.data,
            media_type: image.mimeType,
          },
        });
      }

      const response = await llm.chat({
        model: model || defaultModel,
        messages: [{ role: 'user', content }],
      });

      return {
        analysis: response.content,
        model: model || defaultModel,
        usage: response.usage,
      };
    },
  });
}

export const analyzeImageSchema = z.object({
  image: imageSourceSchema,
  prompt: z.string().optional(),
  detail: z.enum(['auto', 'low', 'high']).optional(),
  model: z.string().optional(),
});

export type AnalyzeImageInput = z.infer<typeof analyzeImageSchema>;
