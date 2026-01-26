import { createChatHandler } from '@cogitator-ai/next';
import { cogitator, chatAgent } from '@/lib/cogitator';

export const POST = createChatHandler(cogitator, chatAgent, {
  beforeRun: async (_req, input) => {
    console.log(`[Chat] Starting with ${input.messages.length} messages`);
  },
  afterRun: async (result) => {
    console.log(`[Chat] Completed. Output length: ${result.output.length}`);
  },
});
