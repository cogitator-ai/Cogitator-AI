import {
  Cogitator,
  Agent,
  createAnalyzeImageTool,
  createGenerateImageTool,
} from '../packages/core/src';

async function main() {
  const cog = new Cogitator({
    llm: {
      defaultProvider: 'openai',
      providers: {
        openai: {
          apiKey: process.env.OPENAI_API_KEY!,
        },
      },
    },
  });

  const analyzeImage = createAnalyzeImageTool({
    llmBackend: cog.getDefaultBackend(),
    defaultModel: 'gpt-4o',
  });

  const generateImage = createGenerateImageTool({
    apiKey: process.env.OPENAI_API_KEY!,
    defaultSize: '1024x1024',
    defaultQuality: 'hd',
  });

  const visionAgent = new Agent({
    name: 'vision-assistant',
    model: 'openai/gpt-4o',
    instructions: `You are a vision-capable AI assistant.
You can analyze images and generate new images.

When analyzing images:
- Describe what you see in detail
- Identify objects, text, colors, and composition
- Answer questions about the visual content

When generating images:
- Use the generateImage tool with detailed prompts
- Be creative but follow the user's intent
- Suggest style and quality options when appropriate`,
    tools: [analyzeImage, generateImage],
  });

  console.log('=== Vision Agent Example ===\n');

  console.log('1. Analyzing an image via URL...');
  const analysisResult = await cog.run(visionAgent, {
    input: 'What do you see in this image? Describe it in detail.',
    images: [
      'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg',
    ],
  });
  console.log('Analysis:', analysisResult.output);
  console.log('Tokens used:', analysisResult.usage?.totalTokens);
  console.log();

  console.log('2. Generating an image with DALL-E 3...');
  const generationResult = await cog.run(visionAgent, {
    input:
      'Generate a beautiful image of a sunset over mountains with a calm lake in the foreground. Make it photorealistic.',
  });
  console.log('Generation result:', generationResult.output);
  console.log();

  console.log('3. Multi-image comparison...');
  const comparisonResult = await cog.run(visionAgent, {
    input: 'Compare these two images. What are the similarities and differences?',
    images: [
      'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/1200px-Cat03.jpg',
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat_November_2010-1a.jpg/1200px-Cat_November_2010-1a.jpg',
    ],
  });
  console.log('Comparison:', comparisonResult.output);
  console.log();

  console.log('=== Done ===');
}

main().catch(console.error);
